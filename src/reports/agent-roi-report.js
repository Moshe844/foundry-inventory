'use strict';
// Job 161 (every plan): the monthly ROI report.
//
// Hours saved: the completed agent work of a calendar month, counted from the
// records of each finished action with the same rules as the Time saved page,
// times the minutes each task takes the owner by hand. The owner's own timed
// samples are used where recorded; otherwise StockChief's standard minutes for
// that task, shown as an estimate. Nothing else is counted.
//
// $ caught: money the agent recovered or prevented, each amount backed by a
// record: posted supplier credits from claims, invoice disputes and returns,
// other supplier credit notes it applied, rebate credits, supplier refunds on
// claims, price increases and other invoice errors the supplier corrected,
// duplicate invoices it stopped, freight saved by combining orders, and stock-
// outs avoided where the stock records prove the agent's order arrived before
// the shelf ran empty. Each currency stays separate; only the plan's currency
// is compared with the plan price.
//
// After each month ends the worker makes the report, tells the owner in Needs
// you and, when email alerts are on, emails it. Pause holds it; Watch only, Ask
// me first and the first 14 days make the report without telling. Nothing is
// posted or changed.
const {ValidationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const time=require('../lib/business-time');
const audit=require('../operations/postgres-security-audit');
const installed=require('../db/schema-installed');
const saved=require('../autopilot/time-saved');
const reports=require('./agent-report-runs');

const JOB=161,ACTION='report.roi',KIND='reports.roi.v1',href='/autopilot/reviews/roi-report';

// StockChief's standard minutes for doing one of these tasks by hand, used
// until the owner times it. They are starting estimates and always labelled so.
const STANDARD_MINUTES=Object.freeze({
  'repeat-order':10,'supplier-response':3,'supplier-delivery-followup':5,'staff-request':5,'invoice-match':8,'customer-receipt':4,
  'customer-reminder':4,'arrived-stock':3,'stock-ready':3,'invoice-dispute':15,'customer-statement':5,'quote-followup':4,
  'supplier-forecast':15,'return-email':8,'bin-correction':3,'supplier-details':4,'po-delivery-date':3,'po-supplier-amendment':6,
  'receiving-document':6,'supplier-direct-purchase':8,'supplier-direct-dispatch':6,'delivery-comparison':8,'container-plan':30,
  'team-procedure':20,'product-facts':10,'channel-copy':15,'blanket-release':8,'product-retirement':10,'shutdown-purchase':20,
  'promotion-purchase':20,'delivery-qc':4,'supplier-rfq':8,'supplier-claim':15,'customer-reservation':3,'customer-priority':2,
  'channel-buffer':3,'export-papers':20,'return-disposition':5,'customer-page-order':6,'return-label':6,'partial-shipment':6,
  'annual-stocktake':60,'accounting-export':5,'count-adjustment':4,'repeat-sale':5,'margin-price':5,'combine-purchases':5,'split-purchase':5});

const KINDS=Object.freeze([
  ['claim','Supplier credits from claims'],['claim-refund','Supplier refunds on claims'],['dispute','Supplier credits from invoice disputes'],
  ['return','Supplier credits for returns'],['credit-note','Other supplier credit notes applied'],['rebate','Rebates credited'],
  ['price-increase','Price increases the supplier corrected'],['invoice-error','Other invoice errors the supplier corrected'],
  ['duplicate','Duplicate invoices stopped'],['freight','Freight saved by combining orders'],['stockout','Stock-outs avoided']]);
const kindLabel=new Map(KINDS);
const fmt=(minor,currency)=>money.format(Number(minor),currency);
const hours=minutes=>Math.round(minutes/6)/10;

// ---- Hours saved -----------------------------------------------------------

async function hoursSaved(db,workspaceId,{from,to}){
  const done=await saved.completedWork(db,workspaceId,await saved.features(db),{from,to});
  const timings=await saved.timingSamples(db,workspaceId);
  const tasks=[];
  for(const [key,label] of saved.activities){
    const count=done.find(r=>r.activity===key)?.n||0;if(!count)continue;
    const timed=timings.find(r=>r.activity===key),each=timed?Math.round(Number(timed.net_minutes)*100)/100:STANDARD_MINUTES[key];
    tasks.push({key,label,count,basis:timed?'timed':'standard',samples:timed?.n||0,minutesEach:each,minutes:Math.round(count*each*100)/100});
  }
  const measured=tasks.filter(t=>t.basis==='timed').reduce((n,t)=>n+t.minutes,0),estimated=tasks.filter(t=>t.basis==='standard').reduce((n,t)=>n+t.minutes,0);
  return {tasks,measuredMinutes:Math.round(measured*100)/100,estimatedMinutes:Math.round(estimated*100)/100,actions:tasks.reduce((n,t)=>n+t.count,0)};
}

// ---- $ caught --------------------------------------------------------------

async function caught(db,workspaceId,{start,end,from,to,zone}){
  const has=table=>installed.has(db,'stockchief_runtime.'+table);
  const [rebates,claims,disputes,applications,intakes]=[await has('agent_supplier_benefit_claim_credits'),await has('agent_supplier_claim_settlements'),
    await has('agent_invoice_dispute_work'),await has('agent_supplier_credit_applications'),await has('agent_supplier_invoice_intakes')];
  const found=[];
  // Posted supplier credits in the month, each counted once by what it settled.
  const credits=(await db.query(`SELECT c.id,c.credit_number,c.credit_date,b.currency,s.name AS supplier,
      ${rebates?'rb.amount_minor':'NULL::bigint'} AS rebate_minor,c.amount_minor::bigint AS amount,
      CASE ${rebates?"WHEN rb.claim_id IS NOT NULL THEN 'rebate'":''} ${claims?"WHEN cs.claim_id IS NOT NULL THEN 'claim'":''}
        ${disputes?"WHEN dw.found THEN 'dispute'":''}
        WHEN ${applications?'ap.supplier_return_id IS NOT NULL OR ':''}rr.id IS NOT NULL THEN 'return' ${applications?"WHEN ap.credit_id IS NOT NULL THEN 'credit-note'":''} END AS kind
    FROM accounting_supplier_credits c
    JOIN accounting_supplier_bills b ON b.workspace_id=c.workspace_id AND b.id=c.supplier_bill_id
    JOIN accounting_journal_entries j ON j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id AND j.status='POSTED'
    LEFT JOIN suppliers s ON s.workspace_id=c.workspace_id AND s.id=c.supplier_id
    ${rebates?'LEFT JOIN stockchief_runtime.agent_supplier_benefit_claim_credits rb ON rb.workspace_id=c.workspace_id AND rb.credit_id=c.id':''}
    ${claims?'LEFT JOIN stockchief_runtime.agent_supplier_claim_settlements cs ON cs.workspace_id=c.workspace_id AND cs.credit_id=c.id':''}
    ${disputes?`LEFT JOIN LATERAL (SELECT true AS found FROM stockchief_runtime.agent_invoice_dispute_work w
      WHERE w.workspace_id=c.workspace_id AND w.result->>'supplierCreditId'=c.id LIMIT 1) dw ON true`:''}
    ${applications?'LEFT JOIN stockchief_runtime.agent_supplier_credit_applications ap ON ap.workspace_id=c.workspace_id AND ap.credit_id=c.id':''}
    LEFT JOIN LATERAL (SELECT a.id FROM stockchief_runtime.assistant_action_proposals a WHERE a.workspace_id=c.workspace_id
      AND a.action_type='supplier_return.reconcile' AND a.status='EXECUTED' AND a.result->>'supplierCreditId'=c.id LIMIT 1) rr ON true
    WHERE c.workspace_id=$1 AND c.credit_date BETWEEN $2 AND $3
      AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id AND r.reversal_of_entry_id=j.id AND r.status='POSTED')
    ORDER BY c.credit_date,c.id`,[workspaceId,start,end])).rows;
  for(const c of credits.filter(c=>c.kind))found.push({kind:c.kind,currency:c.currency,amount:Number(c.kind==='rebate'?c.rebate_minor:c.amount),
    date:String(c.credit_date).slice(0,10),record:'Supplier credit '+(c.credit_number||c.id)+(c.supplier?' from '+c.supplier:''),href:'/accounting/payables'});
  if(claims){
    for(const r of (await db.query(`SELECT c.id,c.reference,c.snapshot->>'currency' AS currency,(c.outcome_detail->>'amountMinor')::bigint AS amount,
        (c.outcome_at AT TIME ZONE $4)::date::text AS day,c.outcome_detail->>'reference' AS payment
      FROM stockchief_runtime.agent_supplier_claims c WHERE c.workspace_id=$1 AND c.outcome='REFUNDED' AND c.outcome_at>=$2::timestamptz AND c.outcome_at<$3::timestamptz
        AND (c.outcome_detail->>'amountMinor')::bigint>0 ORDER BY c.outcome_at,c.id`,[workspaceId,from,to,zone])).rows)
      found.push({kind:'claim-refund',currency:r.currency,amount:Number(r.amount),date:r.day,record:'Claim '+r.reference+' refunded ('+r.payment+')',href:'/autopilot/supplier-claims/'+encodeURIComponent(r.id)});
  }
  if(disputes){
    // A disputed invoice the supplier replaced with a lower corrected invoice.
    for(const r of (await db.query(`SELECT b.id,coalesce(b.supplier_invoice_number,b.bill_number) AS invoice,b.currency,(b.total_minor-r.total_minor)::bigint AS amount,
        (r.created_at::timestamptz AT TIME ZONE $4)::date::text AS day,
        EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.exception_detail::jsonb->'differences')='array' THEN b.exception_detail::jsonb->'differences' ELSE '[]'::jsonb END) d
          WHERE d->>'kind'='price_outside_approved_cost') AS price
      FROM stockchief_runtime.agent_invoice_dispute_work w JOIN accounting_supplier_bills b ON b.workspace_id=w.workspace_id AND b.id=w.bill_id
      JOIN accounting_supplier_bills r ON r.workspace_id=w.workspace_id AND r.id=w.replacement_bill_id AND r.status IN ('OPEN','PARTIALLY_PAID','PAID')
      WHERE w.workspace_id=$1 AND r.currency=b.currency AND b.total_minor>r.total_minor
        AND r.created_at::timestamptz>=$2::timestamptz AND r.created_at::timestamptz<$3::timestamptz ORDER BY r.created_at,b.id`,[workspaceId,from,to,zone])).rows)
      found.push({kind:r.price?'price-increase':'invoice-error',currency:r.currency,amount:Number(r.amount),date:r.day,record:'Invoice '+r.invoice+' corrected',href:'/accounting/payables'});
  }
  if(intakes){
    // The same supplier invoice arriving again, stopped before a second bill.
    for(const r of (await db.query(`SELECT q.id,coalesce(b.supplier_invoice_number,b.bill_number) AS invoice,b.currency,b.total_minor::bigint AS amount,
        (q.created_at AT TIME ZONE $4)::date::text AS day
      FROM stockchief_runtime.agent_supplier_invoice_intakes q JOIN accounting_supplier_bills b ON b.workspace_id=q.workspace_id AND b.id=q.duplicate_bill_id AND b.status<>'VOID'
      WHERE q.workspace_id=$1 AND q.status='DUPLICATE' AND q.created_at>=$2::timestamptz AND q.created_at<$3::timestamptz AND b.total_minor>0
        AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_invoice_intakes o WHERE o.workspace_id=q.workspace_id AND o.duplicate_bill_id=q.duplicate_bill_id
          AND o.status='DUPLICATE' AND (o.created_at,o.id)<(q.created_at,q.id)) ORDER BY q.created_at,q.id`,[workspaceId,from,to,zone])).rows)
      found.push({kind:'duplicate',currency:r.currency,amount:Number(r.amount),date:r.day,record:'Invoice '+r.invoice+' received again',href:'/autopilot/supplier-invoices/'+encodeURIComponent(r.id)});
  }
  // Freight saved when combined orders were actually placed with the supplier.
  for(const r of (await db.query(`SELECT DISTINCT ON (p.source_detail::jsonb->'sourcePurchaseOrderIds') p.id,p.po_number,p.currency,
      (p.source_detail::jsonb->'freightConsolidation'->>'savedMinor')::bigint AS amount,(p.ordered_at::timestamptz AT TIME ZONE $4)::date::text AS day
    FROM purchase_orders p WHERE p.workspace_id=$1 AND p.source_detail::jsonb ? 'freightConsolidation' AND p.status<>'CANCELLED' AND p.ordered_at IS NOT NULL
      AND p.ordered_at::timestamptz>=$2::timestamptz AND p.ordered_at::timestamptz<$3::timestamptz
      AND (p.source_detail::jsonb->'freightConsolidation'->>'savedMinor')::bigint>0
      AND p.currency=p.source_detail::jsonb->'freightConsolidation'->>'currency'
    ORDER BY p.source_detail::jsonb->'sourcePurchaseOrderIds',p.ordered_at,p.id`,[workspaceId,from,to,zone])).rows)
    found.push({kind:'freight',currency:r.currency,amount:Number(r.amount),date:r.day,record:'Combined order '+r.po_number,href:'/purchasing/orders/'+encodeURIComponent(r.id)});
  // Stock-outs avoided: goods from an order the agent prepared arrived while
  // stock was still on the shelf, and more was sold before the next delivery
  // than was there before it. Those extra units sold only because it arrived.
  const avoided=(await db.query(`WITH agent_orders AS (
      SELECT DISTINCT w.purchase_order_id FROM work_items w WHERE w.workspace_id=$1 AND w.source='postgres_autopilot'
        AND w.purchase_order_id IS NOT NULL AND w.execution_status='COMPLETED'
    ), arrivals AS (
      SELECT DISTINCT ON (m.id) m.id,m.seq,m.sku_id,m.location_id,m.quantity_delta::numeric AS units,(m.balance_after-m.quantity_delta)::numeric AS before,
        m.occurred_at::timestamptz AS at,p.po_number,p.id AS po_id
      FROM agent_orders a JOIN purchase_orders p ON p.workspace_id=$1 AND p.id=a.purchase_order_id
      JOIN purchase_order_receipts r ON r.workspace_id=p.workspace_id AND r.purchase_order_id=p.id
      JOIN purchase_order_receipt_lines rl ON rl.workspace_id=r.workspace_id AND rl.receipt_id=r.id
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(rl.movement_ids::jsonb)='array' THEN rl.movement_ids::jsonb ELSE '[]'::jsonb END) x(id)
      JOIN movements m ON m.workspace_id=rl.workspace_id AND m.id=x.id AND m.operation='receive' AND m.quantity_delta>0
      WHERE m.occurred_at::timestamptz>=$2::timestamptz AND m.occurred_at::timestamptz<$3::timestamptz
    ), windows AS (
      SELECT a.*,(SELECT min(n.seq) FROM movements n WHERE n.workspace_id=$1 AND n.sku_id=a.sku_id AND n.location_id=a.location_id
        AND n.seq>a.seq AND n.quantity_delta>0) AS next_seq FROM arrivals a WHERE a.before>0
    ), sold AS (
      SELECT w.id,coalesce(sum(-s.quantity_delta),0)::numeric AS sold FROM windows w LEFT JOIN movements s ON s.workspace_id=$1 AND s.sku_id=w.sku_id
        AND s.location_id=w.location_id AND s.seq>w.seq AND (w.next_seq IS NULL OR s.seq<w.next_seq) AND s.operation='issue'
        AND s.reason_code IN ('sale','sold') AND s.occurred_at::timestamptz<$3::timestamptz
      GROUP BY w.id
    ), month_sales AS (
      SELECT m.sku_id,sum(-m.quantity_delta)::numeric AS units FROM movements m WHERE m.workspace_id=$1 AND m.operation='issue' AND m.reason_code IN ('sale','sold')
        AND m.occurred_at::timestamptz>=$2::timestamptz AND m.occurred_at::timestamptz<$3::timestamptz AND m.sku_id IN (SELECT sku_id FROM windows) GROUP BY m.sku_id
    ), revenue AS (
      SELECT l.sku_id,l.currency,sum(l.credit_minor-l.debit_minor)::numeric AS amount FROM accounting_journal_lines l
      JOIN accounting_journal_entries e ON e.workspace_id=l.workspace_id AND e.id=l.entry_id AND e.status='POSTED'
      JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id AND a.system_key='SALES_REVENUE'
      JOIN accounting_settings book ON book.workspace_id=l.workspace_id AND book.enabled=1 AND book.base_currency=l.currency
      WHERE l.workspace_id=$1 AND e.posting_date BETWEEN $5 AND $6 AND l.sku_id IN (SELECT sku_id FROM windows) GROUP BY l.sku_id,l.currency
    )
    SELECT w.id,w.po_id,k.code,loc.name AS location,w.po_number,w.before,s.sold,least(w.units,s.sold-w.before) AS units,(w.at AT TIME ZONE $4)::date::text AS day,
      v.currency,CASE WHEN ms.units>0 AND v.amount>0 THEN round(least(w.units,s.sold-w.before)*v.amount/ms.units)::bigint END AS amount
    FROM windows w JOIN sold s ON s.id=w.id AND s.sold>w.before JOIN skus k ON k.workspace_id=$1 AND k.id=w.sku_id
    JOIN locations loc ON loc.workspace_id=$1 AND loc.id=w.location_id LEFT JOIN month_sales ms ON ms.sku_id=w.sku_id LEFT JOIN revenue v ON v.sku_id=w.sku_id
    ORDER BY w.at,w.id`,[workspaceId,from,to,zone,start,end])).rows;
  const stockouts=avoided.map(r=>({orderId:r.po_id,code:r.code,location:r.location,order:r.po_number,before:Number(r.before),sold:Number(r.sold),units:Number(r.units),date:r.day,
    currency:r.currency||null,amount:r.amount==null?null:Number(r.amount)}));
  for(const r of stockouts.filter(r=>r.amount!=null))found.push({kind:'stockout',currency:r.currency,amount:r.amount,date:r.date,
    record:r.code+' at '+r.location+': '+r.units+' more sold after '+r.order+' arrived with '+r.before+' left',href:'/purchasing/orders/'+encodeURIComponent(r.orderId)});
  return {items:found.filter(f=>f.amount>0&&/^[A-Z]{3}$/.test(String(f.currency||''))),stockouts};
}

// ---- Plan price -------------------------------------------------------------

async function plan(db,workspaceId){
  const row=(await db.query(`SELECT s.plan_id,v.currency,v.monthly_amount_minor,v.annual_amount_minor,s.billing_interval
    FROM workspaces w JOIN account_subscriptions s ON s.account_id=w.owner_account_id JOIN commercial_plan_versions v ON v.id=s.plan_version_id
    WHERE w.id=$1`,[workspaceId])).rows[0];
  if(!row)return null;
  const annual=row.billing_interval==='ANNUAL',minor=annual?(row.annual_amount_minor==null?null:Math.round(Number(row.annual_amount_minor)/12)):row.monthly_amount_minor;
  if(minor==null||!row.currency)return null;
  return {plan:{starter:'Starter',growth:'Growth',pro:'Pro',enterprise:'Custom'}[row.plan_id]||row.plan_id,currency:row.currency,monthly:Number(minor),annual};
}

// ---- The report -------------------------------------------------------------

async function compute(db,workspaceId,{month}){
  const range=reports.span(month),zone=(await time.forWorkspace(db,workspaceId)).timeZone;
  const from=time.dayBoundary(range.start,zone),to=time.dayBoundary(range.end,zone,{nextDay:true});
  const work=await hoursSaved(db,workspaceId,{from,to});
  const money_=await caught(db,workspaceId,{...range,from,to,zone});
  const price=await plan(db,workspaceId);
  const currencies=[...new Set(money_.items.map(i=>i.currency))].sort((a,b)=>(a===price?.currency?-1:b===price?.currency?1:a.localeCompare(b)));
  const totals=currencies.map(currency=>{
    const items=money_.items.filter(i=>i.currency===currency);
    const kinds=KINDS.map(([kind,label])=>{const of=items.filter(i=>i.kind===kind);return {kind,label,count:of.length,amount:of.reduce((n,i)=>n+i.amount,0)};}).filter(k=>k.count);
    const amount=items.reduce((n,i)=>n+i.amount,0);
    return {currency,amount,kinds,comparable:currency===price?.currency,
      timesPlan:currency===price?.currency&&price.monthly>0?Math.round(amount*100/price.monthly)/100:null};
  });
  const totalMinutes=work.measuredMinutes+work.estimatedMinutes;
  return {...range,zone,tasks:work.tasks,actions:work.actions,measuredMinutes:work.measuredMinutes,estimatedMinutes:work.estimatedMinutes,
    hours:hours(totalMinutes),measuredHours:hours(work.measuredMinutes),estimatedHours:hours(work.estimatedMinutes),
    items:money_.items,stockouts:money_.stockouts,totals,plan:price,
    pricePerHour:price&&totalMinutes>0?Math.round(price.monthly*60/totalMinutes):null};
}

// Plain sentences used by Needs you, the email and the page.
function headline(r){
  const parts=[];
  parts.push(r.actions?'StockChief finished '+r.actions+' task'+(r.actions===1?'':'s')+' for you, saving about '+r.hours+' hour'+(r.hours===1?'':'s')+
    (r.estimatedHours?' ('+r.measuredHours+' from your own timings, '+r.estimatedHours+' from standard estimates)':' from your own timings')+'.':'StockChief recorded no finished tasks this month.');
  const own=r.totals.find(t=>t.comparable),others=r.totals.filter(t=>!t.comparable);
  if(own)parts.push('It caught '+fmt(own.amount,own.currency)+' against your '+fmt(r.plan.monthly,r.plan.currency)+' plan price'+(own.timesPlan!=null?' ('+own.timesPlan+' times the price)':'')+'.');
  else if(r.plan)parts.push('It caught no money in '+r.plan.currency+' against your '+fmt(r.plan.monthly,r.plan.currency)+' plan price.');
  for(const t of others)parts.push('It also caught '+fmt(t.amount,t.currency)+', not compared with the plan price because it is in another currency.');
  if(r.pricePerHour!=null)parts.push('Your plan cost '+fmt(r.pricePerHour,r.plan.currency)+' per hour saved.');
  return parts.join(' ');
}

const plain=v=>JSON.parse(JSON.stringify(v));
function ready(r){
  return {key:'ready:'+r.month,detail:{kind:'agent',priority:40,title:'Your ROI report for '+r.name+' is ready',happened:headline(r),
    why:'StockChief reports the time it saved and the money it caught each month.',recommendation:'Open the report to see each task and each amount with its record.',
    href:href+'?'+new URLSearchParams({month:r.month}),actionLabel:'Open the ROI report'}};
}

// Email alerts on and not limited to critical alerts: email the report too.
async function email(c,ctx,r){
  const config=require('../config');
  if(!config.email.configured)return 0;
  const setting=(await c.query('SELECT enabled,minimum_severity,recipients FROM notification_email_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
  if(!Number(setting?.enabled)||setting.minimum_severity==='critical')return 0;
  let to=[];try{to=JSON.parse(setting.recipients||'[]');}catch{to=[];}
  if(!to.length)to=(await c.query(`SELECT a.email FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=$1 AND u.role='owner' AND a.email IS NOT NULL
    ORDER BY u.created_at,u.id`,[ctx.workspaceId])).rows.map(x=>x.email);
  to=[...new Set(to.map(x=>String(x).trim().toLowerCase()).filter(x=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)))];
  if(!to.length)return 0;
  const {escapeHtml}=require('../commercial/notifications'),origin=String(config.connections.publicOrigin||'').replace(/\/$/,'');
  const link=origin?origin+href+'?'+new URLSearchParams({month:r.month}):null;
  const lines=[...r.totals.flatMap(t=>t.kinds.map(k=>k.label+': '+fmt(k.amount,t.currency)+' ('+k.count+')')),
    ...r.tasks.slice(0,10).map(t=>t.label+': '+t.count+' × '+t.minutesEach+' min'+(t.basis==='standard'?' (standard estimate)':''))];
  const account=(await c.query(`SELECT a.id FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1`,[ctx.workspaceId])).rows[0];
  const jobs=require('../operations/postgres-job-queue'),credentials=require('../connections/credentials');
  let queued=0;
  for(const address of to){
    const message={to:address,subject:'Your StockChief ROI report for '+r.name,
      text:['Your ROI report for '+r.name,headline(r),...lines,link?'Open the report: '+link:''].filter(Boolean).join('\n\n'),
      html:'<h1>Your ROI report for '+escapeHtml(r.name)+'</h1><p>'+escapeHtml(headline(r))+'</p>'+(lines.length?'<ul>'+lines.map(l=>'<li>'+escapeHtml(l)+'</li>').join('')+'</ul>':'')+
        (link?'<p><a href="'+escapeHtml(link)+'">Open the report</a></p>':'')+'<p>Standard estimates are StockChief’s starting minutes for a task; time a task yourself to replace them.</p>'};
    const job=await jobs.enqueue(reports.scoped(c),{workspaceId:ctx.workspaceId,kind:'system.email-send',idempotencyKey:'roi-report-email:'+ctx.workspaceId+':'+r.month+':'+address,
      payload:{messageType:'scheduled_report',accountId:account?.id||null,sealed:credentials.encrypt(message)},priority:30,maxAttempts:5});
    if(job.created)queued++;
  }
  if(queued)await audit.record(c,ctx,{action:'Emailed the monthly ROI report',reference:r.name,after:{recipients:queued}});
  return queued;
}

// ---- Making the report: worker, owner, schedule ---------------------------

async function produce(c,ctx,month,{automatic,watch=null}){
  const report=plain(await compute(c,ctx.workspaceId,{month}));
  const result=await reports.record(c,ctx,{job:JOB,period:month,facts:report,result:report,flags:automatic?[ready(report)]:[],automatic,watch,
    syncFlags:automatic,action:automatic?'StockChief made the monthly ROI report':'Made the monthly ROI report'});
  const emailed=result.outcome==='PRODUCED'&&result.opened.length?await email(c,ctx,report):0;
  return {...result,emailed};
}
async function due(db,workspaceId,today){
  const month=reports.lastCompleted(today);
  const started=(await db.query('SELECT created_at::timestamptz AS at FROM workspaces WHERE id=$1',[workspaceId])).rows[0]?.at;
  if(!started)return null;
  const zone=(await time.forWorkspace(db,workspaceId)).timeZone;
  return new Date(started)<new Date(time.dayBoundary(reports.monthEnd(month),zone,{nextDay:true}))?month:null;
}
// Worker: the report for the month that just ended.
async function run(database,workspaceId,payload={}){
  const actorId=await reports.currentOwner(database,workspaceId);if(!actorId)return {skipped:'owner_unavailable'};
  const ctx={workspaceId,actorId},state=await policy.accountState(database,workspaceId);
  if(!reports.alone(state,JOB))return {skipped:'plan'};
  if(await reports.paused(database,workspaceId))return {held:'paused'};
  const today=await time.today(database,workspaceId),month=await due(database,workspaceId,today);
  if(!month)return {skipped:'not_started'};
  if(payload.month&&payload.month!==month)return {skipped:'stale'};
  return reports.tx(database,async c=>produce(c,ctx,month,{automatic:true,watch:await reports.automaticStop(c,workspaceId,state,ACTION)}));
}
async function schedule(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);if(!reports.alone(state,JOB))return {queued:0};
  const today=await time.today(db,workspaceId),month=await due(db,workspaceId,today);if(!month)return {queued:0};
  if((await db.query(`SELECT 1 FROM ${reports.tables.runs} WHERE workspace_id=$1 AND job_id=$2 AND period=$3 AND outcome='PRODUCED' AND authorization_kind='AUTOMATIC' LIMIT 1`,
    [workspaceId,JOB,month])).rowCount)return {queued:0};
  // Daily after the month ends until the report is made and the owner told (a
  // watched report is made again once StockChief may tell); the same facts replay.
  const job=await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:KIND,priority:70,maxAttempts:3,idempotencyKey:'roi-report:'+month+':'+today,payload:{month}});
  return {queued:job.created?1:0};
}
// The owner makes a month's report now and keeps it (Ask me first included).
async function checkNow(database,ctx,input={}){
  await reports.owner(database,ctx);
  const state=await policy.requireWorkspaceJob(database,ctx.workspaceId,JOB,'draft');
  const stop=await policy.stopped(database,ctx.workspaceId,state,ACTION,false);if(stop)throw new ValidationError(stop);
  const month=reports.completedMonth(await time.today(database,ctx.workspaceId),input.month);
  return reports.tx(database,async c=>produce(c,ctx,month,{automatic:false}));
}

// ---- Page, review rows, files ----------------------------------------------

async function access(db,ctx){await reports.owner(db,ctx);return policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'suggest');}
async function page(db,ctx,query={}){
  const state=await access(db,ctx);
  const today=await time.today(db,ctx.workspaceId),month=reports.completedMonth(today,query.month||query.filter);
  const report=await db.transaction(c=>compute(c,ctx.workspaceId,{month}),{isolation:'REPEATABLE READ'});
  const [runs,flags]=[await reports.runs(db,ctx.workspaceId,JOB,{limit:12}),await reports.flagsFor(db,ctx.workspaceId,JOB)];
  const timings=await saved.timingSamples(db,ctx.workspaceId);
  const standards=[...saved.activities].map(([key,label])=>{const t=timings.find(r=>r.activity===key);
    return {key,label,standard:STANDARD_MINUTES[key],timed:t?Math.round(Number(t.net_minutes)*100)/100:null,samples:t?.n||0};});
  return {report,month,months:Array.from({length:12},(_,i)=>reports.addMonths(reports.lastCompleted(today),-i)),runs,flags,standards,kinds:KINDS,
    headline:headline(report),shadow:Boolean(state.shadow),automatic:await reports.automaticStop(db,ctx.workspaceId,state,ACTION),fmt,
    stored:runs.find(r=>r.period===month&&r.outcome!=='STOPPED')||null,
    downloads:{xlsx:href+'/download?'+new URLSearchParams({month,format:'xlsx'}),pdf:href+'/download?'+new URLSearchParams({month,format:'pdf'})}};
}
// Rows for Ask and the review list.
async function readPage(db,ctx,{filter,today}){
  const month=reports.completedMonth(today,filter);
  const r=await compute(db,ctx.workspaceId,{month}),link=href+'?'+new URLSearchParams({month}),rows=[];
  for(const t of r.tasks)rows.push({Month:month,Part:'Hours saved',What:t.label,Count:t.count,Value:hours(t.minutes)+' h',
    Basis:t.basis==='timed'?'Your timing: '+t.minutesEach+' min each':'Standard estimate: '+t.minutesEach+' min each',link});
  for(const total of r.totals)for(const k of total.kinds)rows.push({Month:month,Part:'$ caught',What:k.label,Count:k.count,Value:fmt(k.amount,total.currency),
    Basis:total.comparable?'Plan currency':'Another currency, not compared',link});
  if(r.plan)rows.push({Month:month,Part:'Plan price',What:r.plan.plan+' plan',Count:null,Value:fmt(r.plan.monthly,r.plan.currency),Basis:r.plan.annual?'Yearly price ÷ 12':'Monthly price',link});
  return {rows,more:false,summary:'ROI for '+r.name+'. '+headline(r)};
}

function sections(r){
  const amount=(v,c)=>Number(money.fromMinor(Number(v),c));
  return [
    {name:'Hours saved',heading:'Hours saved',columns:['Task','Finished','Minutes each','Basis','Hours'],
      rows:r.tasks.map(t=>[t.label,t.count,t.minutesEach,t.basis==='timed'?'Your timing':'Standard estimate',hours(t.minutes)]),
      cells:r.tasks.map(t=>[t.label,t.count,t.minutesEach,t.basis==='timed'?'Your timing':'Standard estimate',hours(t.minutes)])},
    {name:'Money caught',heading:'Money caught',columns:['What','Currency','Amount','Date','Record'],
      rows:r.items.map(i=>[kindLabel.get(i.kind),i.currency,amount(i.amount,i.currency),i.date,i.record]),
      cells:r.items.map(i=>[kindLabel.get(i.kind),i.currency,fmt(i.amount,i.currency),i.date,i.record])},
    {name:'Against plan price',heading:'Against your plan price',columns:['Currency','Caught','Plan price','Times the price'],
      rows:r.totals.map(t=>[t.currency,amount(t.amount,t.currency),t.comparable?amount(r.plan.monthly,r.plan.currency):null,t.timesPlan]),
      cells:r.totals.map(t=>[t.currency,fmt(t.amount,t.currency),t.comparable?fmt(r.plan.monthly,r.plan.currency):'Not compared',t.timesPlan??''])}];
}
async function download(db,ctx,query={}){
  await access(db,ctx);
  const format=query.format==='pdf'?'pdf':query.format==='xlsx'||!query.format?'xlsx':null;
  if(!format)throw new ValidationError('Choose Excel or PDF.');
  const month=reports.completedMonth(await time.today(db,ctx.workspaceId),query.month||query.filter);
  const r=plain(await db.transaction(c=>compute(c,ctx.workspaceId,{month}),{isolation:'REPEATABLE READ'}));
  const files=require('./agent-report-files'),parts=sections(r);
  const body=format==='pdf'?await files.pdf({title:'ROI report · '+r.name,subtitle:r.start+' to '+r.end,lines:[headline(r)],
    sections:parts.map(p=>({heading:p.heading,columns:p.columns,rows:p.cells,empty:'Nothing this month.'})),
    footer:'Hours use your own timings where recorded, otherwise StockChief’s standard minutes. Each amount is backed by the record named beside it.'})
    :files.workbook(parts.map(p=>({name:p.name,columns:p.columns,rows:p.rows})));
  return {filename:'roi-report-'+month+'.'+format,format,body};
}

module.exports={JOB,ACTION,KIND,href,STANDARD_MINUTES,KINDS,compute,headline,run,schedule,checkNow,page,readPage,download,
  definition:{id:JOB,key:'roi-report',label:'Monthly ROI report: hours saved and money caught',filterLabel:'Completed month (YYYY-MM)',readPage}};
