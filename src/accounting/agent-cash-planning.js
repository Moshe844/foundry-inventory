'use strict';

const {documents,addDays} = require('./customer-money');
const money = require('../domain/currency');
const {createHash} = require('node:crypto');
const policy = require('../commercial/agent-plan');
const {ValidationError} = require('../domain/errors');

function terms(text) {
  const value=String(text||'').trim();
  if(/^(?:due on receipt|cash on delivery|cod)$/i.test(value))return {net:0};
  const net=/^net\s*(\d{1,3})\s*(?:days?)?$/i.exec(value);
  if(net) return {net:Number(net[1])};
  const match=/^(\d{1,2}(?:\.\d{1,2})?)\s*%?\s*\/\s*(\d{1,3})\s*[,;]?\s*(?:net|n)\s*\/?\s*(\d{1,3})$/i.exec(value)||
    /^(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:off\s*)?(?:if\s+paid\s+)?(?:in|within)\s+(\d{1,3})\s+days?(?:\s*[,;]?\s*net\s*(\d{1,3}))?$/i.exec(value);
  if(!match)return {};
  const percent=Number(match[1]),days=Number(match[2]),netDays=match[3]==null?null:Number(match[3]);
  if(percent<=0||(netDays!=null&&days>netDays))return {};
  return {percent,days,net:netDays};
}

function opportunity(bill,today) {
  const term=terms(bill.agreed_discount_terms);
  if(!term.percent || bill.balance_minor!==Number(bill.total_minor) || bill.issue_date>today) return null;
  const deadline=addDays(bill.issue_date,term.days);
  if(deadline<today) return null;
  const basis=money.integer(bill.subtotal_minor,bill.currency);
  const minor=Number((BigInt(basis)*BigInt(Math.round(term.percent*100))+5000n)/10000n);
  return minor>0 && minor<=bill.balance_minor ? {deadline,minor} : null;
}

function weekStart(today){
  const day=new Date(today+'T12:00:00Z').getUTCDay();
  return addDays(today,-((day+6)%7));
}

async function paymentFacts(db,workspaceId,today){
  const bills=await documents(db,workspaceId,'bills',today),end=addDays(today,6);
  const dueThisRun=[],discounts=[];
  for(const bill of bills){
    if(bill.issue_date>today)continue;
    const offer=opportunity(bill,today);
    const due=bill.due_date || (terms(bill.agreed_discount_terms).net!=null ? addDays(bill.issue_date,terms(bill.agreed_discount_terms).net) : null);
    const entry={id:bill.id,supplier:bill.party_name,number:bill.number,currency:bill.currency,due,
      balance:bill.balance_minor,offer,link:bill.href};
    if(offer)discounts.push(entry);
    if(!due||due<=end||offer?.deadline<=end)dueThisRun.push(entry);
  }
  const deadline=entry=>[entry.due,entry.offer?.deadline].filter(Boolean).sort()[0]||'9999-12-31';
  dueThisRun.sort((a,b)=>deadline(a).localeCompare(deadline(b))||a.id.localeCompare(b.id));
  discounts.sort((a,b)=>a.offer.deadline.localeCompare(b.offer.deadline)||a.id.localeCompare(b.id));
  const week=weekStart(today);
  const digest=dueThisRun.length?createHash('sha256').update(JSON.stringify({week,dueThisRun})).digest('hex'):null;
  return {end,week,digest,dueThisRun,discounts};
}

function paymentRow(entry){
  const {offer,currency,balance}=entry;
  return {Supplier:entry.supplier,Bill:entry.number,Due:entry.due||'Confirm due date',
    Balance:money.format(balance,currency),'Discount deadline':offer?.deadline||'',
    'Possible saving':offer?money.format(offer.minor,currency):'',
    'Review amount':money.format(balance-(offer?.minor||0),currency),link:entry.link};
}

async function payments(db,ctx,{today,discountsOnly=false}) {
  const facts=await paymentFacts(db,ctx.workspaceId,today);
  if(discountsOnly)return {summary:'Unpaid posted bills within documented early-payment terms. Confirm the discount basis with the supplier.',
    rows:facts.discounts.map(paymentRow)};
  const result={summary:'Bills due through '+facts.end+', discount deadlines this week and bills needing a due date. Review each bill before paying.',
    rows:facts.dueThisRun.map(paymentRow)};
  const installed=(await db.query("SELECT to_regclass('stockchief_runtime.agent_supplier_payment_approvals') IS NOT NULL AS ready")).rows[0].ready;
  if(!installed)return result;
  const approved=facts.digest&&(await db.query(`SELECT approved_at FROM stockchief_runtime.agent_supplier_payment_approvals
    WHERE workspace_id=$1 AND week_start=$2 AND digest=$3`,[ctx.workspaceId,facts.week,facts.digest])).rows[0];
  const approvalHold=facts.digest&&await require('../autopilot/job-modes').restriction(db,ctx.workspaceId,104,false);
  return {...result,paymentRun:{digest:facts.digest,approvedAt:approved?.approved_at||null,count:facts.dueThisRun.length,approvalHold}};
}

async function approvePaymentRun(db,ctx,{digest,confirmed}){
  if(confirmed!=='yes'||!(/^[a-f0-9]{64}$/).test(digest||''))
    throw new ValidationError('Review the listed bills and confirm this payment run.');
  return db.transaction(async client=>{
    const state=await require('../autopilot/job-reviews').ownerState(client,ctx);
    policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,104,'draft');
    const hold=await require('../autopilot/job-modes').restriction(client,ctx.workspaceId,104,false);
    if(hold)throw new ValidationError(hold);
    const today=await require('../lib/business-time').today(client,ctx.workspaceId);
    const facts=await paymentFacts(client,ctx.workspaceId,today);
    if(facts.digest!==digest)throw new ValidationError('The bills or discount terms changed. Open the current run and review it again.');
    const saved=await client.query(`INSERT INTO stockchief_runtime.agent_supplier_payment_approvals(workspace_id,week_start,digest,approved_by)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING approved_at`,[ctx.workspaceId,facts.week,digest,ctx.actorId]);
    if(saved.rowCount)await require('../operations/postgres-security-audit').record(client,ctx,{action:'Supplier payment run reviewed',
      after:{week:facts.week,billCount:facts.dueThisRun.length,digest}});
    return {replayed:!saved.rowCount};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function preparePaymentChecks(db,workspaceId,state,today){
  const jobs=require('../autopilot/job-modes');
  const prepareRun=policy.permits(state.plan,104,'automatic')&&!await jobs.restriction(db,workspaceId,104,true);
  const findDiscounts=policy.permits(state.plan,108,'automatic')&&!await jobs.restriction(db,workspaceId,108,true);
  if(!prepareRun&&!findDiscounts)return;
  const modes=(prepareRun?1:0)+(findDiscounts?2:0);
  const previous=await db.query(`SELECT 1 FROM stockchief_runtime.agent_supplier_payment_checks
    WHERE workspace_id=$1 AND (checked_on>$2 OR (checked_on=$2 AND check_modes=$3))`,[workspaceId,today,modes]);
  if(previous.rowCount)return;
  const facts=await paymentFacts(db,workspaceId,today);
  await db.query(`INSERT INTO stockchief_runtime.agent_supplier_payment_checks AS prior(workspace_id,checked_on,check_modes,run_digest,bill_count,discount_count)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id) DO UPDATE SET checked_on=excluded.checked_on,check_modes=excluded.check_modes,
    run_digest=excluded.run_digest,bill_count=excluded.bill_count,discount_count=excluded.discount_count
    WHERE prior.checked_on<excluded.checked_on OR (prior.checked_on=excluded.checked_on AND prior.check_modes<>excluded.check_modes)`,
    [workspaceId,today,modes,prepareRun?facts.digest:null,prepareRun?facts.dueThisRun.length:0,findDiscounts?facts.discounts.length:0]);
}

async function forecast(db,ctx,options) {
  return db.transaction(client=>forecastSnapshot(client,ctx,options),{
    isolation:'REPEATABLE READ',readOnly:true,statementTimeoutMs:10000
  });
}

async function forecastSnapshot(db,ctx,{today,adviceOnly=false}) {
  const {timeZone}=await require('../lib/business-time').forWorkspace(db,ctx.workspaceId);
  const books=await documents(db,ctx.workspaceId,'bills',today);
  const invoices=await documents(db,ctx.workspaceId,'invoices',today);
  const lines=(await db.query(`WITH orders AS MATERIALIZED (
    SELECT p.id,p.po_number,p.currency,p.expected_date,s.payment_terms,p.status
    FROM purchase_orders p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
    WHERE p.workspace_id=$1 AND p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')
  ), posted_bills AS MATERIALIZED (
    SELECT b.* FROM accounting_supplier_bills b
    JOIN orders p ON p.id=b.purchase_order_id AND p.currency=b.currency
    JOIN accounting_journal_entries e ON e.workspace_id=b.workspace_id AND e.id=b.journal_entry_id AND e.status='POSTED'
    WHERE b.workspace_id=$1 AND b.status IN ('OPEN','PARTIALLY_PAID','PAID')
  ), billed AS (
    SELECT l.purchase_order_line_id,sum(l.quantity) AS units,sum(l.secondary_quantity) AS measured,
      bool_or(l.secondary_quantity IS NULL) AS missing_measure
    FROM accounting_supplier_bill_lines l JOIN posted_bills b ON b.workspace_id=l.workspace_id AND b.id=l.bill_id
    WHERE l.workspace_id=$1 GROUP BY l.purchase_order_line_id
  ), final_receipt AS (
    SELECT r.purchase_order_id,max(r.received_at::timestamptz) AS received_at FROM purchase_order_receipts r
    JOIN orders p ON p.id=r.purchase_order_id AND p.status='RECEIVED'
    WHERE r.workspace_id=$1 GROUP BY r.purchase_order_id
  ), charge_budget AS (
    SELECT c.purchase_order_id,c.kind,lower(btrim(c.label)) label,sum(c.amount_minor) amount
    FROM purchase_order_charges c JOIN orders p ON p.id=c.purchase_order_id
    WHERE c.workspace_id=$1 AND c.kind<>'deposit' GROUP BY 1,2,3
  ), billed_charges AS (
    SELECT b.purchase_order_id,c->>'kind' kind,lower(btrim(c->>'label')) label,sum((c->>'amountMinor')::bigint) amount
    FROM posted_bills b CROSS JOIN LATERAL jsonb_array_elements(b.charges) c GROUP BY 1,2,3
    UNION ALL SELECT purchase_order_id,'tax','',sum(tax_minor) FROM posted_bills GROUP BY purchase_order_id
  ), unbilled_charges AS (
    SELECT c.purchase_order_id,sum(CASE WHEN c.amount>=0 THEN greatest(c.amount-coalesce(b.amount,0),0)
      ELSE least(c.amount-coalesce(b.amount,0),0) END) amount
    FROM (SELECT purchase_order_id,kind,CASE WHEN kind='tax' THEN '' ELSE label END label,sum(amount) amount
      FROM charge_budget GROUP BY 1,2,3) c
    LEFT JOIN billed_charges b USING(purchase_order_id,kind,label) GROUP BY 1
  )
  SELECT p.id,p.po_number,p.currency,p.expected_date,p.payment_terms,
    to_char(f.received_at AT TIME ZONE $2,'YYYY-MM-DD') AS receipt_date,l.unit_cost,
    CASE WHEN l.secondary_quantity_ordered IS NOT NULL THEN
      CASE WHEN b.missing_measure THEN NULL ELSE
        CASE WHEN l.quantity_received_units>=l.quantity_units THEN l.secondary_quantity_received
          ELSE l.secondary_quantity_ordered END-coalesce(b.measured,0) END
    ELSE greatest(l.quantity_units,l.quantity_received_units)-coalesce(b.units,0) END AS price_quantity,
    NULL::numeric AS charges
  FROM orders p JOIN purchase_order_lines l ON l.workspace_id=$1 AND l.purchase_order_id=p.id
  LEFT JOIN billed b ON b.purchase_order_line_id=l.id LEFT JOIN final_receipt f ON f.purchase_order_id=p.id
  WHERE greatest(l.quantity_units,l.quantity_received_units)>coalesce(b.units,0)
  UNION ALL SELECT p.id,p.po_number,p.currency,p.expected_date,p.payment_terms,
    to_char(f.received_at AT TIME ZONE $2,'YYYY-MM-DD'),NULL,NULL,c.amount
  FROM orders p JOIN unbilled_charges c ON c.purchase_order_id=p.id AND c.amount<>0
  LEFT JOIN final_receipt f ON f.purchase_order_id=p.id`,[ctx.workspaceId,timeZone])).rows;
  const cash=(await db.query(`SELECT l.currency,sum(l.debit_minor-l.credit_minor) AS balance
    FROM accounting_journal_lines l JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
    JOIN accounting_journal_entries e ON e.workspace_id=l.workspace_id AND e.id=l.entry_id AND e.status='POSTED'
    WHERE l.workspace_id=$1 AND a.subtype='CASH' AND e.posting_date<=$2 GROUP BY l.currency`,
  [ctx.workspaceId,today])).rows;
  const opening=new Map(cash.map(row=>[row.currency,money.integer(row.balance,'Cash balance',{signed:true})]));
  const currencies=new Map(),undated=new Map();
  function weeksFor(currency){
    if(!currencies.has(currency))currencies.set(currency,Array.from({length:13},()=>({incoming:0,bills:0,purchases:0,charges:0})));
    return currencies.get(currency);
  }
  function add(currency,date,amount,kind,reference){
    const weeks=weeksFor(currency);
    if(!date || amount===null){undated.set(kind==='charges'?'purchases:'+reference:kind+':'+reference,{currency,reference});return;}
    const days=Math.round((Date.parse(date)-Date.parse(today))/86400000),index=Math.max(0,Math.floor(days/7));
    if(index<13) {const week=weeks[index];week[kind]=money.sum([week[kind],amount]);}
  }
  for(const b of books)add(b.currency,b.due_date,b.balance_minor,'bills',b.number);
  for(const i of invoices)add(i.currency,i.due_date,i.balance_minor,'incoming',i.number);
  for(const l of lines){
    const net=terms(l.payment_terms).net;
    const baseDate=l.receipt_date||l.expected_date;
    const due=baseDate&&net!=null?addDays(baseDate,net):null;
    const amount=l.charges!=null?money.integer(l.charges,'Purchase charges',{signed:true}):
      l.unit_cost==null||l.price_quantity==null||Number(l.price_quantity)<=0?null:
        require('../domain/exact-quantity').costMinor(l.price_quantity,money.toMinor(l.unit_cost,l.currency));
    add(l.currency,due,amount,l.charges!=null?'charges':'purchases',l.po_number);
  }
  for(const currency of opening.keys())weeksFor(currency);
  const incomplete=new Set([...undated.values()].map(row=>row.currency));
  const rows=[];
  for(const [currency,weeks] of [...currencies].sort(([a],[b])=>a.localeCompare(b))){
    let balance=incomplete.has(currency)?null:opening.get(currency)??null;
    let suggested=false;
    weeks.forEach((w,index)=>{
      const week=addDays(today,index*7),net=money.sum([w.incoming,-w.bills,-w.purchases,-w.charges]);
      if(balance!==null)balance=money.sum([balance,net]);
      if(adviceOnly){
        if(!suggested&&(balance===null?net<0:balance<0)){
          rows.push({Currency:currency,'Week beginning':week,Review:balance===null?'Expected payments exceed expected receipts.':'Recorded cash plus expected flows falls below zero.'});suggested=true;
        }
        return;
      }
      rows.push({'Week beginning':week,Currency:currency,'Customer receipts':money.format(w.incoming,currency),
        'Supplier bills':money.format(w.bills,currency),'Unbilled PO goods':money.format(w.purchases,currency),
        'Unbilled PO charges':money.format(w.charges,currency),'Net flow':money.format(net,currency),
        'Projected cash':balance===null?null:money.format(balance,currency)});
    });
    if(adviceOnly && !suggested)rows.push({Currency:currency,'Week beginning':today,
      Review:incomplete.has(currency)?'Confirm missing prices or dates before relying on expected flows.':'No cash shortfall among dated records.'});
  }
  return {summary:'Overdue amounts enter week one. Unbilled PO goods and approved charges use recorded supplier terms and actual final receipt or expected delivery. Posted bills include recorded deposits. Projected cash starts with posted cash balances. '+undated.size+' documents need a date or price.'+
    (undated.size?' Review '+[...undated.values()].slice(0,8).map(row=>row.reference).join(', ')+'.':''),rows};
}
module.exports={payments,approvePaymentRun,preparePaymentChecks,forecast,terms};
