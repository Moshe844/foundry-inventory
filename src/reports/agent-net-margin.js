'use strict';
// Job 85: true net margin per item, channel and customer.
//
// Fees come from the owner's checked cost import for an order, or else from the
// owner's fee terms for the order's channel. Shipping comes from the same
// import, or else from the carrier labels and carrier costs recorded on the
// order's shipments, return parcels included. Returns and credits come from the
// posted ledger. A cost that is not recorded is shown as missing, never as zero,
// and currencies are never added together.
//
// On Growth, Pro and Custom the worker keeps the figures current and flags
// items, channels and customers below the owner's lowest net margin in Needs
// you. Pause holds the check; Watch only, Ask me first and the first 14 days
// only watch. Nothing here posts money or changes a price.
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const audit=require('../operations/postgres-security-audit');
const storage=require('../commercial/storage-capacity');
const {hash}=require('../pricing/postgres-promotions');
const {newId}=require('../lib/util');

const JOB=85,ACTION='report.net_margin_alert',KIND='reports.net-margin.v1',href='/autopilot/net-contribution',DIRECT='Direct';
const tables={fees:'stockchief_runtime.agent_channel_fee_rules',rules:'stockchief_runtime.agent_net_margin_rules',
  runs:'stockchief_runtime.agent_net_margin_runs',alerts:'stockchief_runtime.agent_net_margin_alerts'};
const KINDS={ITEM:'item',CHANNEL:'channel',CUSTOMER:'customer'};
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(sql,args)=>c.query(sql,args),transaction:operation=>operation(c)});
const alone=state=>policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'automatic');
const percentText=bps=>(Number(bps)/100).toFixed(Number(bps)%100?2:0).replace(/(\.\d)0$/,'$1')+'%';

async function owner(db,ctx,{lock=false}={}){
  if(!(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)${lock?' FOR SHARE OF u,w':''}`,
  [ctx.workspaceId,ctx.actorId])).rowCount)throw new AuthorizationError('Only the current inventory owner can change net margin settings.');
}
async function currentOwner(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.role='owner' ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}

// ---- Recorded cost facts for a set of loaded orders -------------------------

async function feeRules(db,workspaceId){
  return (await db.query(`SELECT * FROM ${tables.fees} WHERE workspace_id=$1 AND enabled ORDER BY channel_key,currency LIMIT 1000`,[workspaceId])).rows;
}
async function connectedChannels(db,workspaceId,ids){
  const out=new Map();if(!ids.length)return out;
  const rows=(await db.query(`SELECT m.foundry_record_id order_id,c.id connector_id,c.display_name FROM connection_mappings m
    JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id
    WHERE m.workspace_id=$1 AND m.entity_type='sales_order' AND m.foundry_record_id=ANY($2::text[]) ORDER BY m.foundry_record_id,c.id LIMIT 100001`,[workspaceId,ids])).rows;
  if(rows.length>100000)throw new ValidationError('The connected-channel history exceeds this review limit. Narrow the order dates.');
  for(const r of rows){const list=out.get(r.order_id)||[];if(!list.some(x=>x.id===r.connector_id))list.push({id:r.connector_id,name:r.display_name});out.set(r.order_id,list);}
  return out;
}
async function shipments(db,workspaceId,ids){
  const out=new Map();if(!ids.length)return out;
  const rows=(await db.query(`SELECT s.id,s.sales_order_id,s.shipment_number,s.status,s.handover,s.shipping_cost_minor::text cost,s.currency,s.customer_return_id,
      coalesce(json_agg(json_build_object('id',t.id,'operation',t.operation,'status',t.status,'amount',t.amount_minor::text,'currency',t.currency,
        'refund',t.refund_status,'purchase',t.purchase_transaction_id) ORDER BY t.requested_at,t.id) FILTER (WHERE t.id IS NOT NULL),'[]') AS labels
    FROM sales_shipments s LEFT JOIN shipping_label_transactions t ON t.workspace_id=s.workspace_id AND t.shipment_id=s.id
    WHERE s.workspace_id=$1 AND s.sales_order_id=ANY($2::text[]) AND s.status<>'CANCELLED'
    GROUP BY s.id ORDER BY s.sales_order_id,s.id LIMIT 100001`,[workspaceId,ids])).rows;
  if(rows.length>100000)throw new ValidationError('The shipment history exceeds this review limit. Narrow the order dates.');
  for(const r of rows){if(!out.has(r.sales_order_id))out.set(r.sales_order_id,[]);out.get(r.sales_order_id).push(r);}
  return out;
}

// Carrier cost from what is recorded on the order's parcels. A label still
// being confirmed, a void whose refund is not confirmed, or a parcel that left
// with no cost recorded is missing, not zero.
function shippingCost(order,list){
  if(!list.length)return order.delivery_method==='PICKUP'?{minor:0,source:'Collected by the customer'}:{minor:null,problem:'No shipment or carrier cost is recorded.'};
  let total=0n;const problems=[],sources=new Set();
  for(const s of list){
    const name=s.customer_return_id?'return parcel '+s.shipment_number:s.shipment_number,labels=Array.isArray(s.labels)?s.labels:[];
    const purchases=labels.filter(t=>t.operation==='PURCHASE');
    if(purchases.some(p=>['PENDING','REVIEW'].includes(p.status))){problems.push('The label for '+name+' is still being confirmed.');continue;}
    const bought=purchases.filter(p=>p.status==='SUCCEEDED');
    if(bought.length){
      for(const p of bought){
        if(p.amount==null){problems.push('The label cost for '+name+' is not recorded.');continue;}
        if(p.currency!==order.currency){problems.push('The label for '+name+' was paid in '+p.currency+'. It is not converted.');continue;}
        total+=BigInt(p.amount);sources.add('Carrier labels');
        for(const v of labels.filter(t=>t.operation==='VOID'&&t.purchase===p.id&&t.status!=='FAILED')){
          if(v.status!=='SUCCEEDED'||!['CONFIRMED','REJECTED'].includes(v.refund)){problems.push('The carrier refund for the voided label on '+name+' is not confirmed.');continue;}
          if(v.refund==='REJECTED')continue;
          if(v.amount==null){problems.push('The carrier refund for the voided label on '+name+' has no amount.');continue;}
          total-=BigInt(v.amount);
        }
      }
      continue;
    }
    if(s.cost!=null){
      if(s.currency&&s.currency!==order.currency){problems.push('The carrier cost for '+name+' is in '+s.currency+'. It is not converted.');continue;}
      total+=BigInt(s.cost);sources.add('Recorded carrier cost');continue;
    }
    if(s.handover==='COLLECTED'){sources.add('Collected by the customer');continue;}
    // A parcel that has not left yet has cost nothing so far.
    if(!['SHIPPED','DELIVERED'].includes(s.status))continue;
    problems.push('No carrier cost is recorded for '+name+'.');
  }
  if(problems.length)return {minor:null,problem:problems.join(' ')};
  return {minor:Number(total),source:[...sources].join(', ')||'No carrier cost so far'};
}

// Marketplace and processing fees from the owner's terms for the channel:
// a percentage of the original sale plus a fixed amount per order. Fee refunds
// on returns are not assumed; a checked import covers those exactly.
function feeCost(order,channel,rules){
  if(channel.problem)return {minor:null,problem:channel.problem};
  const rule=rules.get(channel.name.toLowerCase()+'|'+order.currency);
  if(!rule)return {minor:null,problem:'No fee record or fee terms for '+channel.name+' in '+order.currency+'.'};
  const sale=order.lines.reduce((n,l)=>n+BigInt(l.weight),0n);
  const percent=sale>0n?(sale*BigInt(rule.percent_bps)+5000n)/10000n:0n;
  return {minor:Number(percent+BigInt(rule.fixed_minor)),source:channel.name+' fee terms'};
}

// For each loaded order: its channel, recorded fees and recorded shipping.
async function recorded(db,workspaceId,orders,facts){
  // One after another: db may be a single transaction client.
  const ids=[...orders.keys()],mapped=await connectedChannels(db,workspaceId,ids),parcels=await shipments(db,workspaceId,ids),rules=await feeRules(db,workspaceId);
  const byChannel=new Map(rules.map(r=>[r.channel_key+'|'+r.currency,r])),out=new Map();
  for(const order of orders.values()){
    const links=mapped.get(order.id)||[];
    const channel=links.length>1?{name:links.map(l=>l.name).join(' / '),problem:'This order is linked to more than one connected channel.'}
      :links.length?{name:links[0].name,connectorId:links[0].id}:{name:facts?.get(order.id)?.channel||DIRECT};
    out.set(order.id,{channel:channel.name,fees:feeCost(order,channel,byChannel),shipping:shippingCost(order,parcels.get(order.id)||[])});
  }
  return out;
}

// ---- Owner's fee terms per channel ----------------------------------------

function plainText(value,label,max){
  const text=String(value??'').trim();
  if(!text||text.length>max||/[\u0000-\u001f\u007f]/.test(text))throw new ValidationError('Enter '+label+' on one line, up to '+max+' characters.');
  return text;
}
function percentBps(value,{label,min=0,max=10000}){
  const text=String(value??'').trim().replace(/%$/,'').trim();
  if(!/^\d{1,3}(?:\.\d{1,2})?$/.test(text))throw new ValidationError(label+' must be a percentage with up to two decimals.');
  const [whole,fraction='']=text.split('.'),bps=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(bps<min||bps>max)throw new ValidationError(label+' must be from '+(min/100)+'% to '+(max/100)+'%.');
  return bps;
}
async function saveFeeRule(database,ctx,input){
  return tx(database,async c=>{
    await owner(c,ctx,{lock:true});
    const id=String(input.id||'').trim(),revision=Number(input.revision||0);
    const prior=id?(await c.query(`SELECT * FROM ${tables.fees} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,id])).rows[0]:null;
    if(id&&!prior)throw new NotFoundError('Those fee terms are not in this inventory.');
    if(!Number.isSafeInteger(revision)||(prior?.revision||0)!==revision)throw new ValidationError('These fee terms changed. Reload before saving.');
    if(input.remove==='yes'){
      if(!prior)throw new ValidationError('Choose the fee terms to remove.');
      await c.query(`DELETE FROM ${tables.fees} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
      await audit.record(c,ctx,{action:'Channel fee terms removed',reference:prior.channel+' '+prior.currency,before:{percentBps:prior.percent_bps,fixedMinor:Number(prior.fixed_minor)}});
      return {removed:true};
    }
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'suggest');
    const channel=plainText(input.channel,'the sales channel as it appears in the report',100),currency=money.code(input.currency);
    const bps=percentBps(input.percent,{label:'The fee percentage'});
    const fixed=String(input.fixed??'').trim()===''?0:money.userToMinor(input.fixed,currency,{label:'The fixed fee per order'});
    const source=plainText(input.sourceReference,'where these terms come from',200);
    const clash=(await c.query(`SELECT id FROM ${tables.fees} WHERE workspace_id=$1 AND channel_key=$2 AND currency=$3 AND id<>$4`,[ctx.workspaceId,channel.toLowerCase(),currency,id])).rows[0];
    if(clash)throw new ValidationError(channel+' already has fee terms in '+currency+'. Change those instead.');
    if(prior&&prior.channel===channel&&prior.currency===currency&&prior.percent_bps===bps&&Number(prior.fixed_minor)===fixed&&prior.source_reference===source)return {unchanged:true};
    if(!prior)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    await storage.reserve(scoped(c),ctx.workspaceId,'channel-fee:'+(prior?.id||'new')+':'+((prior?.revision||0)+1)+':'+channel.toLowerCase().slice(0,60)+':'+currency,1024,{finished:true});
    if(prior)await c.query(`UPDATE ${tables.fees} SET channel=$3,channel_key=$4,currency=$5,percent_bps=$6,fixed_minor=$7,source_reference=$8,authorized_by=$9,
        revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,channel,channel.toLowerCase(),currency,bps,fixed,source,ctx.actorId]);
    else await c.query(`INSERT INTO ${tables.fees}(workspace_id,id,channel,channel_key,currency,percent_bps,fixed_minor,source_reference,authorized_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[ctx.workspaceId,newId('feeterms'),channel,channel.toLowerCase(),currency,bps,fixed,source,ctx.actorId]);
    await audit.record(c,ctx,{action:'Channel fee terms saved',reference:channel+' '+currency,
      before:prior?{channel:prior.channel,currency:prior.currency,percentBps:prior.percent_bps,fixedMinor:Number(prior.fixed_minor)}:{},
      after:{channel,currency,percentBps:bps,fixedMinor:fixed,source}});
    return {saved:true};
  });
}

// ---- The margin check -------------------------------------------------------

async function readRule(db,workspaceId,{lock=false}={}){
  return (await db.query(`SELECT * FROM ${tables.rules} WHERE workspace_id=$1${lock?' FOR UPDATE':''}`,[workspaceId])).rows[0]||null;
}
// Why StockChief only watches right now, or null.
async function automaticStop(db,workspaceId,state){
  const stop=await policy.stopped(db,workspaceId,state,ACTION,true);if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAct)return 'StockChief is watching only. Change its authority to get margin alerts.';
  return null;
}
function marginBps(net,revenue){
  if(revenue<=0)return null;
  const n=BigInt(net)*10000n,d=BigInt(revenue),q=n/d,r=n%d;
  return Number(q+(2n*(r<0n?-r:r)>=d?(n<0n?-1n:1n):0n));
}
function below(s,thresholdBps){
  if(s.net==null)return false;
  return s.revenue>0?BigInt(s.net)*10000n<BigInt(thresholdBps)*BigInt(s.revenue):s.net<0;
}
const key=s=>s.kind+'|'+s.key+'|'+s.currency;

async function evaluate(db,ctx,periodDays){
  const contribution=require('./agent-net-contribution'),days=require('../purchasing/fx-reference');
  const end=await require('../lib/business-time').today(db,ctx.workspaceId);
  const start=new Date(Date.parse(end+'T00:00:00Z')-(periodDays-1)*86400000).toISOString().slice(0,10);days.day(start);
  let report;
  try{report=await contribution.screen(db,ctx,{start,end,group:'order'});}
  catch(error){if(error instanceof ValidationError)return {start,end,problem:error.message,subjects:[],incomplete:[]};throw error;}
  const subjects=[];
  for(const [kind,group] of Object.entries(KINDS))for(const g of contribution.aggregate(report.rows,group))
    subjects.push({kind,key:g.key,label:g.label,currency:g.currency,orders:g.orders,missing:g.missing,revenue:g.revenue,net:g.net,marginBps:g.net==null?null:marginBps(g.net,g.revenue)});
  const incomplete=report.rows.filter(r=>r.net==null).map(r=>({order:r.order_number,id:r.id,problem:r.problem}));
  return {start,end,orders:report.rows.length,subjects,incomplete};
}
function snapshot(evaluation,flagged){
  const per=new Map();
  for(const s of evaluation.subjects){const list=per.get(s.kind)||[];list.push(s);per.set(s.kind,list);}
  const groups={};
  for(const [kind,list] of per)groups[kind]=list.sort((a,b)=>(a.net==null)-(b.net==null)||(a.marginBps??-1e9)-(b.marginBps??-1e9)||a.label.localeCompare(b.label)).slice(0,200)
    .map(s=>({key:s.key,label:s.label,currency:s.currency,orders:s.orders,missing:s.missing,revenue:s.revenue,net:s.net,marginBps:s.marginBps}));
  return {start:evaluation.start,end:evaluation.end,orders:evaluation.orders||0,groups,incompleteCount:evaluation.incomplete.length,
    incomplete:evaluation.incomplete.slice(0,20),flagged:flagged.map(s=>({kind:s.kind,label:s.label,currency:s.currency,marginBps:s.marginBps,net:s.net,revenue:s.revenue}))};
}

// Open, update and clear alerts for one evaluation. The same facts replay to the same run.
async function record(c,ctx,evaluation,rule,{automatic,watch=null}){
  const threshold=rule?.enabled?Number(rule.threshold_bps):null;
  const flagged=threshold==null?[]:evaluation.subjects.filter(s=>below(s,threshold));
  const outcome=evaluation.problem?'STOPPED':watch?'WATCHED':'CHECKED';
  const runKey=hash({outcome,watch,threshold,start:evaluation.start,end:evaluation.end,problem:evaluation.problem||null,automatic,
    subjects:evaluation.subjects.map(s=>[key(s),s.revenue,s.net,s.orders,s.missing]),incomplete:evaluation.incomplete.map(r=>[r.id,r.problem])});
  await storage.reserve(scoped(c),ctx.workspaceId,'net-margin-run:'+runKey.slice(0,48),4096+evaluation.subjects.length*256,{finished:true});
  const runId=newId('marginrun');
  const inserted=(await c.query(`INSERT INTO ${tables.runs}(workspace_id,id,run_key,start_date,end_date,outcome,reason,authorization_kind,result,created_by)
    VALUES($1,$2,$3,$4::date,$5::date,$6,$7,$8,'{}'::jsonb,$9) ON CONFLICT(workspace_id,run_key) DO NOTHING RETURNING id`,
  [ctx.workspaceId,runId,runKey,evaluation.start,evaluation.end,outcome,evaluation.problem||watch,automatic?'AUTOMATIC':'INDIVIDUAL',automatic?null:ctx.actorId])).rows[0];
  if(!inserted){const prior=(await c.query(`SELECT id,result FROM ${tables.runs} WHERE workspace_id=$1 AND run_key=$2`,[ctx.workspaceId,runKey])).rows[0];
    return {replayed:true,runId:prior.id,outcome,opened:[],updated:[],cleared:[],...prior.result};}
  const figures=snapshot(evaluation,flagged);
  if(outcome!=='CHECKED'){
    const result={...figures,reason:evaluation.problem||watch,opened:[],updated:[],cleared:[]};
    await c.query(`UPDATE ${tables.runs} SET result=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,runId,JSON.stringify(result)]);
    return {runId,outcome,...result};
  }
  const current=(await c.query(`SELECT * FROM ${tables.alerts} WHERE workspace_id=$1 AND status IN ('OPEN','DISMISSED') ORDER BY id FOR UPDATE`,[ctx.workspaceId])).rows;
  const byKey=new Map(current.map(a=>[a.subject_kind+'|'+a.subject_key+'|'+a.currency,a]));
  const opened=[],updated=[],cleared=[];
  for(const s of flagged){
    const existing=byKey.get(key(s));
    if(existing){
      await c.query(`UPDATE ${tables.alerts} SET label=$3,orders=$4,revenue_minor=$5,net_minor=$6,margin_bps=$7,threshold_bps=$8,last_run_id=$9,updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,existing.id,s.label,s.orders,s.revenue,s.net,s.marginBps,threshold,runId]);
      updated.push(existing.id);continue;
    }
    const id=newId('marginalert');
    await c.query(`INSERT INTO ${tables.alerts}(workspace_id,id,subject_kind,subject_key,currency,label,orders,revenue_minor,net_minor,margin_bps,threshold_bps,status,opened_run_id,last_run_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'OPEN',$12,$12)`,[ctx.workspaceId,id,s.kind,s.key,s.currency,s.label,s.orders,s.revenue,s.net,s.marginBps,threshold,runId]);
    opened.push(id);
  }
  const present=new Map(evaluation.subjects.map(s=>[key(s),s])),still=new Set(flagged.map(key));
  for(const a of current){
    const k=a.subject_kind+'|'+a.subject_key+'|'+a.currency;if(still.has(k))continue;
    const s=present.get(k);let reason=null;
    if(s&&s.net!=null)reason='Back at or above your '+percentText(threshold)+' net margin.';
    else if(!s)reason='No posted sales from '+evaluation.start+' to '+evaluation.end+'.';
    if(!reason)continue;// Missing costs never clear an alert.
    await c.query(`UPDATE ${tables.alerts} SET status='CLEARED',cleared_reason=$3,cleared_at=clock_timestamp(),last_run_id=$4,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,a.id,reason,runId]);
    cleared.push(a.id);
  }
  const result={...figures,threshold,opened,updated,cleared};
  if(opened.length||cleared.length)await audit.record(c,ctx,{action:automatic?'StockChief checked net margins':'Checked net margins',
    reference:'Orders dated '+evaluation.start+' to '+evaluation.end,before:{open:current.filter(a=>a.status==='OPEN').map(a=>a.id)},
    after:{opened,cleared,threshold,flagged:figures.flagged.map(f=>f.kind+' '+f.label)}});
  await c.query(`UPDATE ${tables.runs} SET result=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,runId,JSON.stringify(result)]);
  return {runId,outcome,...result};
}

async function hasPostedSales(db,workspaceId){
  return (await db.query(`SELECT EXISTS(SELECT 1 FROM accounting_journal_entries WHERE workspace_id=$1 AND source_record_type='sales_order' AND status='POSTED') AS sold`,[workspaceId])).rows[0].sold;
}
// Worker: keep the figures current and open or clear alerts on its own.
async function run(database,workspaceId){
  const actorId=await currentOwner(database,workspaceId);if(!actorId)return {skipped:'owner_unavailable'};
  const ctx={workspaceId,actorId},state=await policy.accountState(database,workspaceId);
  if(!alone(state))return {skipped:'plan'};
  const pilot=(await database.query('SELECT paused,suspended FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0];
  if(Number(pilot?.paused)||Number(pilot?.suspended))return {held:'paused'};
  if(!(await hasPostedSales(database,workspaceId)))return {skipped:'no_sales'};
  return tx(database,async c=>{
    const rule=await readRule(c,workspaceId);
    const evaluation=await evaluate(c,ctx,rule?.period_days||30);
    return record(c,ctx,evaluation,rule,{automatic:true,watch:await automaticStop(c,workspaceId,state)});
  });
}
async function schedule(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);if(!alone(state))return {queued:0};
  if(!(await hasPostedSales(db,workspaceId)))return {queued:0};
  // Every six hours, so the figures and alerts follow the day's sales, returns and costs.
  const slot=Math.floor(Date.now()/21600000);
  const job=await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:KIND,priority:70,maxAttempts:3,idempotencyKey:'net-margin:'+slot,payload:{}});
  return {queued:job.created?1:0};
}
// The owner checks now; with Ask me first, alerts open on the owner's say.
async function checkNow(database,ctx){
  await owner(database,ctx);
  const state=await policy.requireWorkspaceJob(database,ctx.workspaceId,JOB,'draft');
  const stop=await policy.stopped(database,ctx.workspaceId,state,ACTION,false);if(stop)throw new ValidationError(stop);
  return tx(database,async c=>{
    const rule=await readRule(c,ctx.workspaceId);if(!rule?.enabled)throw new ValidationError('Choose your lowest net margin first.');
    return record(c,ctx,await evaluate(c,ctx,rule.period_days),rule,{automatic:false});
  });
}
async function dismiss(database,ctx,alertId){
  return tx(database,async c=>{
    await owner(c,ctx);
    const row=(await c.query(`UPDATE ${tables.alerts} SET status='DISMISSED',dismissed_by=$3,dismissed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND id=$2 AND status='OPEN' RETURNING subject_kind,label,margin_bps`,[ctx.workspaceId,String(alertId||''),ctx.actorId])).rows[0];
    if(!row)throw new ValidationError('This alert is no longer open.');
    await audit.record(c,ctx,{action:'Marked a net margin alert as seen',reference:row.label,after:{alertId,kind:row.subject_kind,marginBps:row.margin_bps}});
    return {dismissed:true};
  });
}
// The owner's lowest acceptable net margin and the sales period it looks at.
async function configure(database,ctx,input){
  return tx(database,async c=>{
    await owner(c,ctx,{lock:true});
    const prior=await readRule(c,ctx.workspaceId,{lock:true});
    if(Number(input.revision||0)!==(prior?.revision||0))throw new ValidationError('Reload the margin rule before changing it.');
    if(input.stop==='yes'){
      if(prior?.enabled){
        await c.query(`UPDATE ${tables.rules} SET enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1`,[ctx.workspaceId]);
        const closed=(await c.query(`UPDATE ${tables.alerts} SET status='CLEARED',cleared_reason='You turned off net margin alerts.',cleared_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE workspace_id=$1 AND status IN ('OPEN','DISMISSED') RETURNING id`,[ctx.workspaceId])).rows.map(r=>r.id);
        await audit.record(c,ctx,{action:'Turned off net margin alerts',before:{thresholdBps:prior.threshold_bps,periodDays:prior.period_days},after:{cleared:closed}});
      }
      return {stopped:true};
    }
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm when StockChief should flag a low net margin.');
    const threshold=percentBps(input.thresholdPercent,{label:'The lowest net margin',min:1,max:9999});
    const period=Number(String(input.periodDays??'30').trim());
    if(!Number.isSafeInteger(period)||period<7||period>365)throw new ValidationError('Look back 7 to 365 days.');
    if(prior?.enabled&&prior.threshold_bps===threshold&&prior.period_days===period&&prior.authorized_by===ctx.actorId)return {unchanged:true};
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await storage.reserve(scoped(c),ctx.workspaceId,'net-margin-rule:'+((prior?.revision||0)+1),1024,{finished:true});
    await c.query(`INSERT INTO ${tables.rules}(workspace_id,threshold_bps,period_days,authorized_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(workspace_id) DO UPDATE SET threshold_bps=EXCLUDED.threshold_bps,period_days=EXCLUDED.period_days,authorized_by=EXCLUDED.authorized_by,
        enabled=true,revision=agent_net_margin_rules.revision+1,updated_at=clock_timestamp()`,[ctx.workspaceId,threshold,period,ctx.actorId]);
    await audit.record(c,ctx,{action:'Saved the net margin rule',before:prior?{thresholdBps:prior.threshold_bps,periodDays:prior.period_days,enabled:prior.enabled}:{},
      after:{thresholdBps:threshold,periodDays:period}});
    return {saved:true};
  });
}

// What the page shows about fee terms, the rule, alerts and the latest checks.
async function pageState(db,ctx,state,allowed){
  const [fees,channels]=await Promise.all([feeRules(db,ctx.workspaceId),db.query(`SELECT DISTINCT display_name FROM workspace_connectors
    WHERE workspace_id=$1 AND status='connected' AND provider_type NOT IN ('gmail','microsoft365','quickbooks','xero','supplier_email') ORDER BY display_name LIMIT 50`,[ctx.workspaceId])]);
  const out={fees:fees.map(f=>({...f,percent:(f.percent_bps/100).toString(),fixed:money.fromMinor(Number(f.fixed_minor),f.currency),fixedText:money.format(Number(f.fixed_minor),f.currency)})),
    channels:[...new Set([DIRECT,...channels.rows.map(r=>r.display_name),...fees.map(f=>f.channel)])],
    rule:null,alerts:[],cleared:[],runs:[],automatic:null,shadow:Boolean(state.shadow),percentText};
  if(!allowed)return out;
  const [rule,alerts,cleared,runs]=await Promise.all([readRule(db,ctx.workspaceId),
    db.query(`SELECT * FROM ${tables.alerts} WHERE workspace_id=$1 AND status IN ('OPEN','DISMISSED') ORDER BY status DESC,margin_bps NULLS FIRST,id LIMIT 100`,[ctx.workspaceId]),
    db.query(`SELECT id,label,subject_kind,status,cleared_reason,coalesce(cleared_at,dismissed_at) AS at FROM ${tables.alerts} WHERE workspace_id=$1 AND status='CLEARED' ORDER BY cleared_at DESC,id LIMIT 10`,[ctx.workspaceId]),
    db.query(`SELECT id,outcome,reason,authorization_kind,result,start_date::text start_date,end_date::text end_date,created_at FROM ${tables.runs} WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 5`,[ctx.workspaceId])]);
  return {...out,rule,alerts:alerts.rows,cleared:cleared.rows,runs:runs.rows,automatic:rule?.enabled?await automaticStop(db,ctx.workspaceId,state):null};
}

// Needs you: open alerts, and a check that stopped or found missing costs.
async function inbox(db,workspaceId){
  const installed=require('../db/schema-installed');
  if(!(await installed.has(db,tables.alerts))||!(await installed.has(db,tables.runs)))return [];
  const state=await policy.accountState(db,workspaceId);if(!alone(state))return [];
  const [alerts,latest]=await Promise.all([db.query(`SELECT id,subject_kind,label,currency,orders,revenue_minor,net_minor,margin_bps,threshold_bps,updated_at
      FROM ${tables.alerts} WHERE workspace_id=$1 AND status='OPEN' ORDER BY margin_bps NULLS FIRST,id LIMIT 50`,[workspaceId]),
    db.query(`SELECT id,outcome,reason,result,created_at FROM ${tables.runs} WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,[workspaceId])]);
  const out=alerts.rows.map(a=>{
    const what=a.subject_kind==='ITEM'?'Item':a.subject_kind==='CHANNEL'?'Channel':'Customer',net=Number(a.net_minor);
    return {kind:'sales',importance:'Needs You',priority:58,title:what+' below your net margin: '+a.label,
      happened:(a.margin_bps==null?'Lost '+money.format(Math.abs(net),a.currency)+' with no net sales':'Net margin '+percentText(a.margin_bps)+' ('+money.format(net,a.currency)+' on '+money.format(Number(a.revenue_minor),a.currency)+' net sales)')+' across '+a.orders+' order'+(a.orders===1?'':'s')+'.',
      why:'Your lowest net margin is '+percentText(a.threshold_bps)+', after fees, shipping and returns.',
      recommendation:'Check its fees, shipping and prices. StockChief has not changed any price.',
      href:href+'#margin-alert-'+a.id,actionLabel:'Review net margin',sourceId:'net-margin:'+a.id,createdAt:a.updated_at,at:a.updated_at,
      moneyCurrency:a.currency,moneyValue:Math.abs(net)};
  });
  const run=latest.rows[0];
  if(run?.outcome==='STOPPED')out.push({kind:'sales',importance:'Needs You',priority:56,title:'The net margin check stopped',happened:String(run.reason||'The check could not finish.'),
    why:'StockChief does not guess margins.',recommendation:'Shorten the period in your margin rule, or review the orders.',href:href+'#margin-rule',actionLabel:'Review net margin',
    sourceId:'net-margin-check:'+run.id,createdAt:run.created_at,at:run.created_at});
  else if(run?.outcome==='CHECKED'&&Number(run.result?.incompleteCount)>0){
    const n=Number(run.result.incompleteCount),first=run.result.incomplete?.[0];
    out.push({kind:'sales',grouped:true,importance:'Needs You',priority:54,title:'Net margin is missing costs for '+n+' order'+(n===1?'':'s'),
      happened:first?first.order+': '+first.problem:'Some orders have no fee or shipping cost recorded.',
      why:'A missing fee or carrier cost is never counted as zero, so these margins are not shown.',
      recommendation:'Add fee terms for the channel, record the carrier cost, or import the checked costs.',href:href,actionLabel:'Add missing costs',
      sourceId:'net-margin-missing:'+run.id,createdAt:run.created_at,at:run.created_at});
  }
  return out;
}

module.exports={JOB,ACTION,KIND,href,DIRECT,recorded,shippingCost,feeCost,saveFeeRule,readRule,configure,evaluate,record,run,schedule,checkNow,dismiss,pageState,inbox,marginBps,percentText};
