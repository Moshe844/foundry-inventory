'use strict';
// Job 201: StockChief pauses itself when its automatic spend or volume looks
// unusual. Excluded on Starter; alone on Growth, Pro and Custom.
//
// What it counts is everything StockChief does on its own:
//  - automatic purchase orders and transfers (the routine's work items);
//  - shipping labels it buys within the owner's per-label limit;
//  - every other automatic action, recorded once in agent_automatic_actions
//    (migration 500): a prepared change a routine or approved plan carries out
//    (refunds and credits, stock changes, landed costs, customer orders and so
//    on), an email it sends to a supplier or customer on its own, a price or
//    purchase cost it changes, and a delivery cost bill it posts.
// Today's count of all actions, of each kind, and its money in each currency
// are compared with the previous 28 days in the inventory's time zone, once
// four active days give a usual day. Above twice the usual day (or above the
// normal spread) it latches the pause, audits it, opens an urgent Needs you
// item and emails the owner at once from the mailbox they chose for it. The
// email goes out during the pause it reports.
//
// Every automatic job stops while paused (agent-plan stopped()). Only the
// owner can resume (PDF page 13: anyone can press Pause). The resume records
// what the owner reviewed; activity before it no longer counts toward today.
// Nothing trips during the first 14 days or in Watch only, where nothing is
// automatic.
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const time=require('../lib/business-time');
const {has}=require('../db/schema-installed');
const {addDays}=require('../accounting/customer-money');
const {ValidationError,AuthorizationError}=require('../domain/errors');

const JOB=201,prefix='Unusual automatic activity',key='unusual-automatic-activity',path='/autopilot/reviews/'+key;
const TABLE='stockchief_runtime.agent_automatic_actions',NOTICES='stockchief_runtime.agent_operational_notices';
const KINDS={purchase:'purchase orders',transfer:'transfers',label:'shipping labels',email:'emails to suppliers and customers',
  credit:'refunds and credits',landed_cost:'delivery cost postings',price:'price and cost changes',stock:'stock changes',sale:'customer orders',change:'other changes'};
const capitalised=text=>text[0].toUpperCase()+text.slice(1);
const scales=Object.fromEntries([...Intl.supportedValuesOf('currency'),'CLF','UYW'].map(code=>[code,money.exponent(code)]));

// What kind of automatic action a prepared change is.
function kindOf(actionType){
  const desk=require('./approval-desk').ACTIONS[actionType]?.kind;
  if(desk==='refund')return 'credit';
  if(desk==='landed_cost')return 'landed_cost';
  if(desk==='supplier_price'||/^catalog\.(set_price|set_purchase_cost|restore_margin)/.test(actionType))return 'price';
  if(desk==='adjustment'||/^inventory\./.test(actionType)&&desk!=='transfer')return 'stock';
  if(desk==='transfer')return 'transfer';
  if(/^sales_order\.|^sales_quote\./.test(actionType))return 'sale';
  return 'change';
}

// Records one automatic action, once, and pauses at once if today is now
// unusual. Called inside the transaction that does the work, so a failed
// action records nothing. Older databases without migration 500 skip it.
async function note(db,workspaceId,{key:actionKey,kind,reference=null,amountMinor=null,currency=null}){
  if(!workspaceId||!actionKey||!KINDS[kind]||!await has(db,TABLE))return false;
  const amount=Number(amountMinor),priced=amountMinor!=null&&Number.isSafeInteger(amount)&&amount>=0&&/^[A-Z]{3}$/.test(String(currency||''));
  const added=await db.query(`INSERT INTO ${TABLE}(workspace_id,action_key,kind,reference,currency,amount_minor) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT DO NOTHING RETURNING 1`,[workspaceId,String(actionKey).slice(0,300),kind,reference==null?null:String(reference).slice(0,300),priced?currency:null,priced?amount:null]);
  if(added.rowCount)await refresh(db,workspaceId);
  return Boolean(added.rowCount);
}

// Today's automatic activity against its usual day. With all, every measure
// seen today; otherwise only what is unusual.
async function observations(db,workspaceId,{all=false}={}){
  const {calendarDate:today,timeZone}=await time.forWorkspace(db,workspaceId);
  const totals=require('../operations/postgres-team-access').purchaseTotalsSql('p.workspace_id','p.id',"power(10::numeric,($6::jsonb->>p.currency)::int)");
  const ledger=await has(db,TABLE)?`UNION ALL SELECT a.at,a.kind,a.currency,a.amount_minor::numeric FROM ${TABLE} a
    WHERE a.workspace_id=$1 AND a.at BETWEEN $2 AND clock_timestamp()`:'';
  const threshold='greatest(2*b.median,b.q3+1.5*(b.q3-b.q1))';
  const result=await db.query(`WITH acknowledged AS MATERIALIZED (
    SELECT coalesce((SELECT anomaly_acknowledged_at FROM workspace_autopilot WHERE workspace_id=$1),'-infinity'::timestamptz) AS at
  ), events AS (
    SELECT w.approved_at::timestamptz AS at,CASE WHEN w.purchase_order_id IS NULL THEN 'transfer' ELSE 'purchase' END AS kind,p.currency,
      CASE WHEN t.priced THEN t.lines+t.charges END AS spend
    FROM work_items w LEFT JOIN purchase_orders p ON p.workspace_id=w.workspace_id AND p.id=w.purchase_order_id
    LEFT JOIN LATERAL (${totals}) t ON p.id IS NOT NULL
    WHERE w.workspace_id=$1 AND w.source='postgres_autopilot' AND w.approval_requirement='NONE' AND w.execution_status IN ('COMPLETED','EXECUTING')
      AND w.approved_at::timestamptz BETWEEN $2 AND clock_timestamp()
    UNION ALL SELECT t.completed_at::timestamptz,'label',t.currency,t.amount_minor::numeric FROM shipping_label_transactions t
    JOIN stockchief_runtime.provider_effects e ON e.workspace_id=t.workspace_id AND e.kind='shipping.label.purchase'
      AND e.payload->>'transactionId'=t.id AND e.payload->>'agentPostageScope'='automatic'
    WHERE t.workspace_id=$1 AND t.operation='PURCHASE' AND t.status='SUCCEEDED' AND t.completed_at::timestamptz BETWEEN $2 AND clock_timestamp()
    ${ledger}
  ), counted AS (
    -- Today's activity before the owner's last resume was reviewed already.
    SELECT e.* FROM events e CROSS JOIN acknowledged x WHERE e.at<$5 OR e.at>x.at
  ), daily AS (
    SELECT (at AT TIME ZONE $3)::date AS day,'Count' AS metric,count(*)::numeric AS total FROM counted GROUP BY 1
    UNION ALL SELECT (at AT TIME ZONE $3)::date,'Count:'||kind,count(*)::numeric FROM counted GROUP BY 1,2
    UNION ALL SELECT (at AT TIME ZONE $3)::date,currency,sum(spend) FROM counted WHERE spend>=0 AND currency IS NOT NULL GROUP BY 1,2
  ), basis AS (
    SELECT metric,count(*) AS days,percentile_cont(0.25) WITHIN GROUP(ORDER BY total) AS q1,
      percentile_cont(0.5) WITHIN GROUP(ORDER BY total) AS median,percentile_cont(0.75) WITHIN GROUP(ORDER BY total) AS q3
    FROM daily WHERE day<$4::date GROUP BY metric HAVING count(*)>=4
  ) SELECT d.metric,d.total,coalesce(b.days,0) AS days,b.median,${threshold} AS threshold,coalesce(d.total>${threshold},false) AS unusual
    FROM daily d LEFT JOIN basis b USING(metric) WHERE d.day=$4::date ${all?'':`AND d.total>${threshold}`}
    ORDER BY d.metric='Count' DESC,d.metric LIKE 'Count:%' DESC,d.metric`,
  [workspaceId,time.dayBoundary(addDays(today,-28),timeZone),timeZone,today,time.dayBoundary(today,timeZone),JSON.stringify(scales)]);
  return result.rows;
}
function phrase(s){
  if(s.metric==='Count')return Number(s.total)+' automatic actions';
  if(s.metric.startsWith('Count:'))return Number(s.total)+' automatic '+KINDS[s.metric.slice(6)];
  return money.format(Number(s.total),s.metric)+' committed';
}
function measure(metric){return metric==='Count'?'Actions':metric.startsWith('Count:')?capitalised(KINDS[metric.slice(6)]):metric+' spend';}
function amount(metric,value){return value==null?'':metric.startsWith('Count')?Math.round(Number(value)*10)/10:money.format(Math.round(Number(value)),metric);}
function evidence(rows){
  return rows.map(r=>({measure:measure(r.metric),today:amount(r.metric,r.total),usual:r.median==null?'Not enough history':amount(r.metric,r.median),
    pausesAbove:r.threshold==null?'':amount(r.metric,r.threshold)}));
}

// Checks today's activity and latches the pause when it is unusual.
async function refresh(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic')||state.shadow)return;
  let configured=(await db.query('SELECT mode,paused FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0];
  if(configured?.mode==='OBSERVE'||Number(configured?.paused))return;
  const signals=await observations(db,workspaceId);
  if(!signals.length)return;
  // Automatic jobs can run before the inventory's own settings row exists.
  if(!configured)await require('./postgres-service').ensure(db,workspaceId);
  const reason=prefix+' today. '+signals.map(phrase).join(' and ')+' is above the usual daily range. The owner can review the activity and resume.';
  const latched=await db.query(`UPDATE workspace_autopilot SET paused=1,paused_at=now()::text,paused_by_user_id=NULL,paused_reason=$2,updated_at=now()::text
    WHERE workspace_id=$1 AND mode<>'OBSERVE' AND paused=0 RETURNING paused_at`,[workspaceId,reason]);
  if(!latched.rowCount)return reason;
  await require('../operations/postgres-security-audit').record(db,{workspaceId},{action:'Paused unusual automatic activity',after:{reason,evidence:evidence(signals)}});
  await tell(db,workspaceId,state,latched.rows[0].paused_at);
  return reason;
}

// Opens the Needs you item and emails the owner now.
async function tell(db,workspaceId,state,pausedAt){
  if(!await has(db,TABLE))return;
  const today=await time.today(db,workspaceId);
  await db.query(`INSERT INTO ${NOTICES} AS n(workspace_id,job_id,kind,reference,link,due,last_reminded) VALUES($1,${JOB},'Paused',$2,$3,$4::date,$4::date)
    ON CONFLICT(workspace_id,job_id,kind,reference,link) DO UPDATE SET resolved=false`,[workspaceId,String(pausedAt),path,today]);
  await require('./agent-alerts').raise(db,workspaceId,state,JOB);
}
// The routine notice check keeps the item open while the pause lasts.
async function noticeSql(db,account){
  if(!policy.permits(account.plan,JOB,'automatic')||!await has(db,TABLE))return '';
  return ` UNION ALL SELECT ${JOB},'Paused',a.paused_at,'${path}',$3::date FROM workspace_autopilot a
    WHERE a.workspace_id=$1 AND a.paused=1 AND a.paused_at IS NOT NULL AND a.paused_reason LIKE '${prefix}%'`;
}
function paused(row){return Boolean(Number(row?.paused))&&String(row?.paused_reason||'').startsWith(prefix);}

// Called by every resume while the pause is the breaker's: the audit keeps
// what the owner reviewed, and the item and its unsent email close.
async function resumed(c,ctx,current,{note=''}={}){
  if(!paused(current))return;
  const rows=await observations(c,ctx.workspaceId,{all:true});
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Reviewed unusual automatic activity and resumed',
    before:{reason:current.paused_reason,pausedAt:current.paused_at},after:{reviewed:evidence(rows),...(note?{note}:{})}});
  if(!await has(c,TABLE))return;
  await c.query(`UPDATE ${NOTICES} SET resolved=true WHERE workspace_id=$1 AND job_id=${JOB} AND NOT resolved`,[ctx.workspaceId]);
  await c.query(`DELETE FROM stockchief_runtime.agent_alert_deliveries WHERE workspace_id=$1 AND job_id=${JOB} AND email_batch IS NULL`,[ctx.workspaceId]);
}
// The owner's resume from the review page: they confirm they reviewed it.
async function resume(db,ctx,input={}){
  if(String(input.reviewed||'')!=='yes')throw new ValidationError('Confirm you reviewed today’s automatic work before resuming it.');
  const note=String(input.note||'').trim();
  if(note.length>500)throw new ValidationError('Keep the note under 500 characters.');
  const member=(await db.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  if(member?.role!=='owner')throw new AuthorizationError('Only the owner can resume StockChief after it paused itself.');
  const current=(await db.query('SELECT paused,paused_reason FROM workspace_autopilot WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
  if(!paused(current))throw new ValidationError('StockChief is not paused for unusual activity. Nothing changed.');
  return require('./postgres-service').resume(db,ctx,member,{note});
}

// What the review page shows: today against the usual day, and the pause.
async function status(db,ctx){
  const current=(await db.query('SELECT paused,paused_at,paused_reason FROM workspace_autopilot WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
  return {paused:paused(current),reason:paused(current)?current.paused_reason:null,pausedAt:paused(current)?current.paused_at:null};
}
const summary='Everything StockChief does on its own is compared with the previous 28 days in your inventory’s time zone: purchases, transfers, labels, '+
  'emails to suppliers and customers, refunds and credits, price and cost changes, stock changes and other automatic work, by count and by money in each currency. '+
  'When today is far above a usual day it pauses all automatic work, tells you in Needs you and by email, and waits for you to review it and resume. '+
  'A usual day needs four active days.';
async function review(db,ctx){
  const rows=await observations(db,ctx.workspaceId,{all:true});
  return {summary,rows:rows.map(r=>({Measure:measure(r.metric),Today:amount(r.metric,r.total),'Usual day':r.median==null?'Not enough history':amount(r.metric,r.median),
    'Pauses above':r.threshold==null?'':amount(r.metric,r.threshold),'Active comparison days':Number(r.days),Unusual:r.unusual?'Yes':'No'}))};
}
// One line per open pause, for the alert email.
async function lines(db,workspaceId,keys){
  const reason=(await db.query('SELECT paused_reason FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0]?.paused_reason;
  return keys.map(()=>reason||prefix+'.');
}
// The routine check keeps five weeks: the 28 compared days and today.
async function prune(db,workspaceId){
  if(await has(db,TABLE))await db.query(`DELETE FROM ${TABLE} WHERE workspace_id=$1 AND at<now()-interval '35 days'`,[workspaceId]);
}
const definition={id:JOB,key,label:'Review unusual automatic activity',readPage:review};
module.exports={JOB,key,path,prefix,KINDS,kindOf,note,prune,refresh,observations,noticeSql,resumed,resume,status,lines,paused,definition};
