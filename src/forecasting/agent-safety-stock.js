'use strict';

// Job 150: sets safety stock by how often you can afford to run out.
//
// The owner sets a target for each product class (A, B or C), at one location
// or at all of them: a percentage of reorders that must not run out, or how
// many times a year running out is acceptable. Each day, as part of the
// forecast run (job 144), every stocked product and location with a target
// gets safety stock from the standard formula
//
//   safety stock = z · √( L·σd² + d²·σL² )
//
//   z   the service level the target asks for
//   L   the recorded lead time in days
//   σd  how far daily sales stray from the forecast: the forecast's error on
//       held-out days, or on the weeks scored since, whichever is larger,
//       times this location's share of sales
//   d   daily demand over the lead time, from the forecast planning uses
//   σL  how far deliveries stray from the supplier's promised date, from the
//       last twelve deliveries of the product received in a year
//
// rounded up to whole stocking increments. The value is saved as the safety
// stock of the product and location, so the reorder point check (job 21)
// builds on it. Missing facts hold the change with the reason.
//
// Growth drafts each value for a person to approve. Pro and Custom apply
// values on their own inside the owner's change limit from the reorder point
// check, skip the settings locked there, and draft the rest. Ask me first, a
// pause or routine work being off draft; Watch only and the first 14 days
// only show. Every applied value is audited and can be undone.
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const permissions=require('../actions/permissions');
const installed=require('../db/schema-installed');
const exact=require('../domain/exact-quantity');
const time=require('../lib/business-time');
const abc=require('./monthly-product-classes');
const base=require('./agent-demand-forecast');
const source=require('./location-reorder-source');
const decision=require('../purchasing/replenishment-decision');
const {hash}=require('../pricing/postgres-promotions');
const {addDays}=require('../accounting/customer-money');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');

const JOB=150,CAPABILITY='planning.safety_stock',href='/planning/safety-stock';
const targets='stockchief_runtime.class_service_levels',changes='stockchief_runtime.agent_safety_stock_changes';
const limits='stockchief_runtime.agent_reorder_refresh_rules',locks='stockchief_runtime.agent_reorder_locks';
const MAE_TO_SD=1.25,MIN_DELIVERIES=3,MAX_DELIVERIES=12,DELIVERY_DAYS=365,SCORED_DAYS=182,MIN_WEEKS=4,MIN_SERVICE=0.5,MAX_SERVICE=0.999;
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const amount=v=>v==null?null:exact.canonical(String(v));
const round=(n,places=2)=>Math.round(n*10**places)/10**places;
const key=(skuId,locationId)=>JSON.stringify([skuId,locationId||null]);
const expected=error=>error instanceof ValidationError||['validation_error','forbidden','entitlement_required'].includes(error?.code);

// The z value for a service level (inverse of the standard normal
// distribution, Acklam's approximation; accurate to about 1e-9).
function zFor(p){
  const a=[-39.69683028665376,220.9460984245205,-275.9285104469687,138.357751867269,-30.66479806614716,2.506628277459239];
  const b=[-54.47609879822406,161.5858368580409,-155.6989798598866,66.80131188771972,-13.28068155288572];
  const c=[-0.007784894002430293,-0.3223964580411365,-2.400758277161838,-2.549732539343734,4.374664141464968,2.938163982698783];
  const d=[0.007784695709041462,0.3224671290700398,2.445134137142996,3.754408661907416];
  const tail=q=>(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  if(p<0.02425)return tail(Math.sqrt(-2*Math.log(p)));
  if(p>0.97575)return -tail(Math.sqrt(-2*Math.log(1-p)));
  const q=p-0.5,r=q*q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}
function stdev(values){
  if(values.length<2)return 0;
  const mean=values.reduce((a,b)=>a+b,0)/values.length;
  return Math.sqrt(values.reduce((sum,v)=>sum+(v-mean)**2,0)/(values.length-1));
}

async function member(db,ctx,{owner=false,action='review safety stock'}={}){
  const row=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  if(owner){
    if(!row||row.role!=='owner'||await base.ownerUser(db,ctx.workspaceId)!==ctx.actorId)
      throw new AuthorizationError('Only the business owner can set safety stock targets.');
    return row;
  }
  if(!row)throw new AuthorizationError('Choose an inventory you can access.');
  permissions.assertCan(row,permissions.MANAGE_REPLENISHMENT,action);
  return row;
}

// How far the job may go right now:
//   watch  Watch only, the watch-only setting or the first 14 days: shown only
//   draft  Growth, or Ask me first, a pause or routine work off: a person approves
//   alone  Pro and Custom: applied inside the owner's change limit
async function authority(db,workspaceId,{account=null}={}){
  account=account||await policy.accountState(db,workspaceId);
  const plan=policy.usesAgentTerms(account)?account.plan:null;
  if(!plan||!policy.permits(plan,JOB,'draft'))return {plan:null,account};
  const watch=await policy.stopped(db,workspaceId,account,CAPABILITY,false);
  if(watch)return {plan,level:'watch',reason:watch,account};
  if(!policy.permits(plan,JOB,'automatic'))return {plan,level:'draft',reason:null,account};
  let hold=await policy.stopped(db,workspaceId,account,CAPABILITY,true);
  if(!hold&&!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
    hold='Routine work is off. Choose Handle routine work in StockChief AI to let it change safety stock on its own.';
  return {plan,level:hold?'draft':'alone',reason:hold||null,account};
}

// The owner's change limit and locks from the reorder point check (job 21).
async function changeLimit(db,workspaceId){
  if(!await installed.has(db,limits))return null;
  return (await db.query(`SELECT r.* FROM ${limits} r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by AND u.role='owner'
    JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id AND w.deletion_requested_at IS NULL
    WHERE r.workspace_id=$1 AND r.enabled`,[workspaceId])).rows[0]||null;
}

// Targets saved by the current owner.
async function targetRows(db,workspaceId){
  if(!await installed.has(db,targets,'runouts_per_year'))return [];
  return (await db.query(`SELECT t.class,t.location_id,t.service_level::float8 AS percent,t.runouts_per_year::float8 AS runouts,t.revision,
    coalesce(l.name,'All locations') AS location FROM ${targets} t
    JOIN users u ON u.workspace_id=t.workspace_id AND u.id=t.authorized_by AND u.role='owner'
    JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id AND w.deletion_requested_at IS NULL
    LEFT JOIN locations l ON l.workspace_id=t.workspace_id AND l.id=t.location_id
    WHERE t.workspace_id=$1 AND (t.location_id IS NULL OR (l.is_active=1 AND l.custody_agreement_id IS NULL))
    ORDER BY t.class,t.location_id NULLS FIRST`,[workspaceId])).rows;
}
const targetWords=g=>g.percent!=null?Number(g.percent)+'% of reorders without running out':
  'run out at most '+(Number(g.runouts)===1?'once':Number(g.runouts)+' times')+' a year';

// How late or early each recent delivery came against its promised date.
async function deliveries(db,workspaceId,skuIds){
  const {timeZone}=await time.forWorkspace(db,workspaceId);
  const {rows}=await db.query(`WITH arrivals AS (
      SELECT l.sku_id,p.id,p.expected_date::date AS promised,min(r.received_at::timestamptz) AS arrived
      FROM purchase_order_lines l JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
      JOIN purchase_order_receipt_lines rl ON rl.workspace_id=l.workspace_id AND rl.purchase_order_line_id=l.id
      JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id AND r.purchase_order_id=p.id
      WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND p.status IN ('PARTIALLY_RECEIVED','RECEIVED')
        AND p.ordered_at IS NOT NULL AND p.expected_date IS NOT NULL AND rl.quantity_units>0
        AND r.received_at::timestamptz>=p.ordered_at::timestamptz AND r.received_at::timestamptz>=now()-make_interval(days=>$4)
      GROUP BY l.sku_id,p.id,p.expected_date
    ) SELECT sku_id,((arrived AT TIME ZONE $3)::date-promised)::int AS late FROM (
      SELECT *,row_number() OVER(PARTITION BY sku_id ORDER BY arrived DESC,id DESC) AS n FROM arrivals) x WHERE n<=$5`,
  [workspaceId,skuIds,timeZone,DELIVERY_DAYS,MAX_DELIVERIES]);
  const result=new Map();
  for(const r of rows){if(!result.has(r.sku_id))result.set(r.sku_id,[]);result.get(r.sku_id).push(Number(r.late));}
  return result;
}

// The job 144 forecast's own error: units a day on held-out days, and the
// root mean square of weekly forecasts scored against what then sold.
async function forecastErrors(db,workspaceId,skuIds,today){
  const result=new Map();
  if(!await installed.has(db,'stockchief_runtime.agent_demand_forecasts'))return result;
  for(const r of (await db.query(`SELECT sku_id,status,holdout_error::float8 AS holdout,method_label FROM stockchief_runtime.agent_demand_forecasts
    WHERE workspace_id=$1 AND sku_id=ANY($2::text[])`,[workspaceId,skuIds])).rows)result.set(r.sku_id,{...r,weeks:0,rmse:null});
  for(const r of (await db.query(`SELECT f.sku_id,count(*)::int AS n,sqrt(avg(o.error_units*o.error_units))::float8 AS rmse
    FROM forecast_outcomes o JOIN demand_forecasts f ON f.workspace_id=o.workspace_id AND f.id=o.forecast_id
    WHERE o.workspace_id=$1 AND f.sku_id=ANY($2::text[]) AND f.model_version=$3 AND f.location_id IS NULL AND f.as_of>=$4 AND o.error_units IS NOT NULL
    GROUP BY f.sku_id`,[workspaceId,skuIds,base.MODEL_VERSION,addDays(today,-SCORED_DAYS)])).rows){
    const saved=result.get(r.sku_id);if(saved)Object.assign(saved,{weeks:r.n,rmse:r.rmse});
  }
  return result;
}

// Every stocked product and location these targets cover, each with a new
// safety stock or the reason the facts are not good enough. `goals` replaces
// the saved targets for a one-off estimate.
async function evaluate(db,workspaceId,skuIds,{today=null,goals=null}={}){
  if(!skuIds.length)return [];
  today=today||await time.today(db,workspaceId);
  goals=goals||await targetRows(db,workspaceId);
  if(!goals.length)return [];
  const rows=await require('../purchasing/postgres-replenishment-state').rows(db,workspaceId,{onlySkuIds:skuIds});
  await base.attach(db,workspaceId,rows);
  const args=[workspaceId,skuIds];
  const products=new Map((await db.query(`SELECT s.id sku_id,s.code,i.id item_id,i.name,i.unit_label,i.quantity_precision,i.quantity_increment::text,
    ${abc.category} AS class FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id ${abc.currentJoins('i.id','$3::date')}
    WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1`,[...args,today.slice(0,7)+'-01'])).rows.map(r=>[r.sku_id,r]));
  const locked=new Set(await installed.has(db,locks)?(await db.query(`SELECT sku_id,location_id FROM ${locks} WHERE workspace_id=$1 AND sku_id=ANY($2::text[])`,args))
    .rows.map(r=>key(r.sku_id,r.location_id)):[]);
  const supplierLead=new Set((await db.query(`SELECT DISTINCT sku_id FROM stockchief_runtime.supplier_planning_leads
    WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND coalesce(observed_lead,configured_lead) IS NOT NULL`,args)).rows.map(r=>r.sku_id));
  const errors=await forecastErrors(db,workspaceId,skuIds,today),late=await deliveries(db,workspaceId,skuIds);
  const bySku=new Map(),result=[];
  for(const row of rows){if(!bySku.has(row.sku_id))bySku.set(row.sku_id,[]);bySku.get(row.sku_id).push(row);}
  for(const [skuId,list] of bySku){
    const product=products.get(skuId);
    if(!product)continue;
    const sites=list.filter(r=>r.location_id&&r.scope!=='workspace');
    const global=list.find(r=>r.scope==='workspace');
    const local=sites.filter(r=>!r.planning_suppressed&&(Number(r.on_hand)!==0||r.policy_location_id===r.location_id||Number(r.issue_events)>0));
    const totalIssued=sites.reduce((sum,r)=>sum+Number(r.issued||0),0);
    for(const row of global?[global]:local){
      const locationId=global?null:row.location_id,k=key(skuId,locationId);
      const known=['A','B','C'].includes(product.class);
      const goal=known&&(locationId&&goals.find(g=>g.class===product.class&&g.location_id===locationId)||goals.find(g=>g.class===product.class&&g.location_id==null));
      if(known&&!goal)continue;
      if(!known&&!goals.some(g=>g.location_id==null||g.location_id===locationId))continue;
      const p={skuId,locationId,itemId:product.item_id,code:product.code,name:product.name,location:locationId?row.location_name:'All locations',
        unit:product.unit_label,class:product.class,goal:goal||null,current:amount(row.safety_stock)};
      const hold=reason=>result.push({...p,hold:reason});
      if(!known){hold(product.class==='Review'?'Some sales of this product have no recorded stock cost, so it has no A, B or C class yet.':
        'This month\'s A, B and C classes are not ready yet.');continue;}
      if(locked.has(k)){hold('You locked these settings on Keep reorder points up to date.');continue;}
      const assumed=global?row.global_policy?.lead_time_days==null&&!supplierLead.has(skuId):row.lead_time_assumed;
      const leadSource=global?(assumed?null:row.lead_time_days):row.local_lead??(assumed?null:row.lead_time_days);
      const lead=Math.ceil(Number(leadSource));
      if(leadSource==null||!Number.isSafeInteger(lead)||lead<0||lead>365){hold('Record a lead time for this product or its supplier first.');continue;}
      const f=errors.get(skuId);
      if(!f||f.holdout==null){hold('Needs a tested sales forecast first. A forecast is tested once the product has about 44 days of sales.');continue;}
      const lates=late.get(skuId)||[];
      if(lates.length<MIN_DELIVERIES){hold('Needs '+MIN_DELIVERIES+' deliveries received against a promised date to measure how much delivery times vary. '+
        (lates.length?'There '+(lates.length===1?'is 1':'are '+lates.length)+' so far.':'There are none yet.'));continue;}
      const share=global?1:row.forecast?Number(row.forecast.share):totalIssued>0?Number(row.issued||0)/totalIssued:sites.length===1?1:null;
      if(share==null){hold('No sales in the last 90 days at any location, so the forecast error cannot be split between locations.');continue;}
      const days=Math.max(lead,1);
      const demand=row.forecast?decision.forecastUnits(row.forecast,days)/days:Number(row.issued||0)/decision.WINDOW_DAYS;
      const weekly=f.weeks>=MIN_WEEKS&&f.rmse!=null?f.rmse/Math.sqrt(7):null;
      const spread=Math.max(MAE_TO_SD*f.holdout,weekly??0)*share,leadSpread=stdev(lates);
      // How many times a year this product is reordered here: demand over the
      // gap between the reorder point and the target, or over the cover days.
      const gap=Number(row.target_stock)-Number(row.reorder_point);
      const batch=row.target_stock!=null&&row.reorder_point!=null&&gap>0?gap:demand*Number(row.cover_days??decision.COVER_DAYS);
      const reorders=demand>0&&batch>0?Math.min(365,Math.max(1,365*demand/batch)):1;
      const wanted=goal.percent!=null?goal.percent/100:1-goal.runouts/reorders;
      const service=Math.min(MAX_SERVICE,Math.max(MIN_SERVICE,wanted)),z=round(zFor(service),4);
      const raw=z*Math.sqrt(lead*spread*spread+demand*demand*leadSpread*leadSpread);
      const after=amount(source.roundedUnits(raw,product));
      const first=p.current==null||Number(p.current)===0;
      const percent=first?null:Math.ceil(Math.abs(Number(after)-Number(p.current))/Number(p.current)*10000-1e-6)/100;
      const evidence={code:p.code,name:p.name,location:p.location,unit:p.unit,class:p.class,target:targetWords(goal),targetPercent:goal.percent??null,
        runouts:goal.runouts??null,service:round(service*100,1),reorders:round(reorders,1),z,lead,demand:round(demand,4),spread:round(spread,4),
        spreadFrom:weekly!=null&&weekly>MAE_TO_SD*f.holdout?'weeks':'held-out days',weeks:f.weeks,deliveries:lates.length,leadSpread:round(leadSpread,2),
        forecast:row.forecast?.label||f.method_label||null,before:p.current,after};
      result.push({...p,estimate:{after,percent,first,changed:p.current!==after,evidence}});
    }
  }
  return result;
}
async function position(db,workspaceId,skuId,locationId){
  return (await evaluate(db,workspaceId,[skuId])).find(p=>p.locationId===(locationId||null))||null;
}

const valueKey=p=>hash([p.skuId,p.locationId,p.current,p.estimate.after]);
function decide(auth,p,rule){
  if(auth.level==='watch')return {status:'WATCHED',reason:auth.reason};
  if(auth.level==='draft')return {status:'DRAFT',reason:auth.reason||null};
  const e=p.estimate;
  if(rule&&(e.first?rule.fill_missing:e.percent<=rule.max_change_percent))return {status:'APPLY'};
  if(!rule)return {status:'DRAFT',reason:'Save your change limit on Keep reorder points up to date to let it change safety stock on its own.'};
  if(e.first)return {status:'DRAFT',reason:'This sets a first safety stock here. Your limit asks you to approve those.'};
  return {status:'DRAFT',reason:'This changes safety stock by '+e.percent+'%, more than your '+rule.max_change_percent+'% limit.'};
}

async function insert(c,workspaceId,runId,p,status,fields={}){
  const id=newId('safety-change'),e=p.estimate;
  await c.query(`INSERT INTO ${changes}(id,run_id,workspace_id,sku_id,location_id,status,reason,before_safety,after_safety,change_percent,value_key,evidence,
    authority,rule_revision,policy_id,created_policy,before_source,decided_by,decided_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19)`,
  [id,runId,workspaceId,p.skuId,p.locationId,status,fields.reason||null,p.current,e?.after??null,e?.percent??null,e?valueKey(p):null,
    JSON.stringify(e?.evidence||{code:p.code,name:p.name,location:p.location,unit:p.unit,class:p.class}),fields.authority||null,fields.ruleRevision??null,
    fields.policyId||null,fields.created===true,fields.beforeSource||null,fields.decidedBy||null,fields.decidedAt||null]);
  return id;
}

// Saves the new safety stock while the setting still holds the value this
// check started from. Job 21 builds the reorder point on it.
async function apply(c,ctx,p,{runId,changeId=null,authority:by,ruleRevision=null,decidedBy=null}){
  const {skuId,locationId}=p,e=p.estimate;
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([ctx.workspaceId,skuId,locationId])]);
  const saved=(await c.query(`SELECT id,safety_stock::text,source FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2 AND location_id IS NOT DISTINCT FROM $3 FOR UPDATE`,
    [ctx.workspaceId,skuId,locationId])).rows[0];
  if(amount(saved?.safety_stock)!==p.current)throw new ValidationError('Safety stock changed since this check. The next check starts from the new value.');
  if(!locationId&&!saved)throw new ValidationError('The setting for all locations was removed.');
  const at=nowIso(),note='Safety stock for your target: '+e.evidence.target;
  let policyId=saved?.id,created=false;
  if(saved)await c.query(`UPDATE reorder_policies SET safety_stock=$3,source='foundry',notes=$4,updated_at=$5 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,policyId,e.after,note,at]);
  else{
    policyId=newId('rpol');created=true;
    await c.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,safety_stock,source,notes,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'foundry',$6,$7,$7)`,[policyId,ctx.workspaceId,skuId,locationId,e.after,note,at]);
  }
  const fields={authority:by,ruleRevision,policyId,created,beforeSource:saved?.source||null,decidedBy,decidedAt:at};
  let id=changeId;
  if(changeId)await c.query(`UPDATE ${changes} SET status='APPLIED',reason=NULL,authority=$3,rule_revision=$4,policy_id=$5,created_policy=$6,before_source=$7,
    decided_by=$8,decided_at=$9 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,changeId,by,ruleRevision,policyId,created,fields.beforeSource,decidedBy,at]);
  else id=await insert(c,ctx.workspaceId,runId,p,'APPLIED',fields);
  await audit.record(c,ctx,{action:'Updated safety stock for your service target',reference:id,
    before:{skuId,locationId,safetyStock:p.current},
    after:{skuId,locationId,safetyStock:e.after,unit:p.unit,class:p.class,target:e.evidence.target,service:e.evidence.service,lead:e.evidence.lead,
      demand:e.evidence.demand,spread:e.evidence.spread,leadSpread:e.evidence.leadSpread,percent:e.percent,authority:by,ruleRevision,runId,routine:!decidedBy}});
  return {id,policyId};
}

async function replace(c,workspaceId,ids,reason){
  if(ids.length)await c.query(`UPDATE ${changes} SET status='REPLACED',reason=$3 WHERE workspace_id=$1 AND id=ANY($2::text[]) AND status='DRAFT'`,[workspaceId,ids,reason]);
}

// One step of the daily forecast run (job 144): this page's products, right
// after their forecasts are refreshed and before the reorder point check.
async function step(c,ctx,{run,skuIds,today,account}){
  const counts={safety_applied:0,safety_waiting:0,safety_shown:0,safety_held:0};
  if(!skuIds.length||!await installed.has(c,changes))return counts;
  const auth=await authority(c,ctx.workspaceId,{account});
  if(!auth.plan)return counts;
  const ws=ctx.workspaceId;
  // Shown values and reasons describe only the latest check; decisions stay.
  await c.query(`DELETE FROM ${changes} WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND run_id IS DISTINCT FROM $3 AND status IN ('WATCHED','HELD','REPLACED')`,
    [ws,skuIds,run.id]);
  const list=await evaluate(c,ws,skuIds,{today});
  const rule=auth.level==='alone'?await changeLimit(c,ws):null;
  const history=(await c.query(`SELECT id,sku_id,location_id,status,value_key,run_id FROM ${changes}
    WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND (status IN ('DRAFT','DECLINED','UNDONE') OR run_id=$3)`,[ws,skuIds,run.id])).rows;
  const declined=new Map(history.filter(r=>['DECLINED','UNDONE'].includes(r.status)).map(r=>[r.value_key,r.status]));
  const done=new Set(history.filter(r=>r.run_id===run.id).map(r=>key(r.sku_id,r.location_id)));
  const open=new Map();
  for(const r of history.filter(r=>r.status==='DRAFT')){const k=key(r.sku_id,r.location_id);open.set(k,[...(open.get(k)||[]),r]);}
  const seen=new Set();
  for(const p of list){
    const k=key(p.skuId,p.locationId),drafts=open.get(k)||[];
    seen.add(k);
    if(done.has(k))continue;
    if(p.hold){await replace(c,ws,drafts.map(d=>d.id),p.hold);await insert(c,ws,run.id,p,'HELD',{reason:p.hold});counts.safety_held++;continue;}
    if(!p.estimate.changed){await replace(c,ws,drafts.map(d=>d.id),'Already up to date.');continue;}
    const value=valueKey(p),prior=declined.get(value);
    let verdict=decide(auth,p,rule);
    if(prior&&['DRAFT','APPLY'].includes(verdict.status))verdict={status:'HELD',reason:(prior==='UNDONE'?'You undid':'You kept the current value instead of')+
      ' this change. It will look again when sales, deliveries or targets change.'};
    const kept=verdict.status==='DRAFT'&&drafts.find(d=>d.value_key===value);
    await replace(c,ws,drafts.filter(d=>d!==kept).map(d=>d.id),'Replaced by a newer check.');
    if(kept){
      await c.query(`UPDATE ${changes} SET reason=$3 WHERE workspace_id=$1 AND id=$2`,[ws,kept.id,verdict.reason||null]);
      counts.safety_waiting++;continue;
    }
    if(verdict.status==='APPLY'){
      await c.query('SAVEPOINT safety_stock');
      try{
        await apply(c,ctx,p,{runId:run.id,authority:'RULE',ruleRevision:rule.revision});
        await c.query('RELEASE SAVEPOINT safety_stock');counts.safety_applied++;continue;
      }catch(error){
        if(!expected(error))throw error;
        await c.query('ROLLBACK TO SAVEPOINT safety_stock');await c.query('RELEASE SAVEPOINT safety_stock');
        verdict={status:'DRAFT',reason:error.message};
      }
    }
    await insert(c,ws,run.id,p,verdict.status,{reason:verdict.reason});
    counts[{WATCHED:'safety_shown',DRAFT:'safety_waiting',HELD:'safety_held'}[verdict.status]]++;
  }
  // A removed target or a product no longer stocked ends its waiting values.
  for(const [k,drafts] of open)if(!seen.has(k))await replace(c,ws,drafts.map(d=>d.id),'No safety stock target covers this product and location now.');
  return counts;
}

async function get(c,ctx,id){
  const row=(await c.query(`SELECT * FROM ${changes} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,String(id||'')])).rows[0];
  if(!row)throw new NotFoundError('That safety stock change is not in this inventory.');
  return row;
}
async function decisionAuthority(c,ctx){
  await member(c,ctx,{action:'approve safety stock'});
  await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
  const auth=await authority(c,ctx.workspaceId);
  policy.requireJob(auth.plan,JOB,'draft');
  return auth;
}
async function approveOne(c,ctx,auth,id){
  if(auth.level==='watch')throw new ValidationError(auth.reason);
  const change=await get(c,ctx,id);
  if(change.status==='APPLIED'&&change.authority==='PERSON'&&change.decided_by===ctx.actorId)return {id,replayed:true};
  if(change.status!=='DRAFT')throw new ValidationError('This change is no longer waiting for approval.');
  const p=await position(c,ctx.workspaceId,change.sku_id,change.location_id);
  if(!p||p.hold)throw new ValidationError(p?.hold||'No safety stock target covers this product and location now.');
  if(!p.estimate.changed||valueKey(p)!==change.value_key)
    throw new ValidationError('Sales, deliveries or settings changed since this was drafted. The next check drafts a fresh value.');
  return apply(c,ctx,p,{runId:change.run_id,changeId:id,authority:'PERSON',decidedBy:ctx.actorId});
}
async function approve(db,ctx,id){return tx(db,async c=>approveOne(c,ctx,await decisionAuthority(c,ctx),id));}
async function approveAll(db,ctx){
  return tx(db,async c=>{
    const auth=await decisionAuthority(c,ctx);
    if(auth.level==='watch')throw new ValidationError(auth.reason);
    const ids=(await c.query(`SELECT id FROM ${changes} WHERE workspace_id=$1 AND status='DRAFT' ORDER BY created_at,id LIMIT 100`,[ctx.workspaceId])).rows.map(r=>r.id);
    const held=[];let approved=0;
    for(const id of ids){
      await c.query('SAVEPOINT safety_stock_approve');
      try{await approveOne(c,ctx,auth,id);await c.query('RELEASE SAVEPOINT safety_stock_approve');approved++;}
      catch(error){
        if(!expected(error))throw error;
        await c.query('ROLLBACK TO SAVEPOINT safety_stock_approve');await c.query('RELEASE SAVEPOINT safety_stock_approve');
        held.push({id,reason:error.message});
      }
    }
    return {approved,held};
  });
}
async function decline(db,ctx,id){
  return tx(db,async c=>{
    await decisionAuthority(c,ctx);
    const change=await get(c,ctx,id);
    if(change.status==='DECLINED')return {id,replayed:true};
    if(change.status!=='DRAFT')throw new ValidationError('This change is no longer waiting for approval.');
    await c.query(`UPDATE ${changes} SET status='DECLINED',decided_by=$3,decided_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Kept the current safety stock',reference:id,
      before:{skuId:change.sku_id,locationId:change.location_id,safetyStock:amount(change.before_safety)},after:{proposed:amount(change.after_safety)}});
    return {id};
  });
}
// Undo restores the earlier value while the setting still holds what this
// change wrote. A person may undo on any plan.
async function undo(db,ctx,id){
  return tx(db,async c=>{
    await member(c,ctx,{action:'undo safety stock'});
    const change=await get(c,ctx,id);
    if(change.status==='UNDONE')return {id,replayed:true};
    if(change.status!=='APPLIED')throw new ValidationError('Only an applied change can be undone.');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([ctx.workspaceId,change.sku_id,change.location_id])]);
    const saved=(await c.query('SELECT id,safety_stock::text FROM reorder_policies WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,change.policy_id])).rows[0];
    if(!saved||amount(saved.safety_stock)!==amount(change.after_safety))
      throw new ValidationError('Safety stock changed after this update. Review the current setting instead.');
    await c.query(`UPDATE reorder_policies SET safety_stock=$3,source=$4,notes=$5,updated_at=$6 WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,saved.id,change.before_safety,change.before_source||'foundry','Earlier safety stock restored by undo',nowIso()]);
    await c.query(`UPDATE ${changes} SET status='UNDONE',undone_by=$3,undone_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Undid safety stock change',reference:id,
      before:{skuId:change.sku_id,locationId:change.location_id,safetyStock:amount(change.after_safety)},
      after:{skuId:change.sku_id,locationId:change.location_id,safetyStock:amount(change.before_safety)}});
    return {id};
  });
}

// The owner's targets: a class, one location or all of them, and either a
// percentage or how many times a year running out is acceptable.
async function setTarget(db,ctx,input){
  return tx(db,async c=>{
    await member(c,ctx,{owner:true});
    await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
    const cls=String(input.class||''),locationId=input.locationId?String(input.locationId):null;
    if(!['A','B','C'].includes(cls))throw new ValidationError('Choose product class A, B or C.');
    const args=[ctx.workspaceId,locationId,cls];
    const prior=(await c.query(`SELECT * FROM ${targets} WHERE workspace_id=$1 AND location_id IS NOT DISTINCT FROM $2 AND class=$3 FOR UPDATE`,args)).rows[0];
    if(input.remove==='1'){
      if(prior){
        await c.query(`DELETE FROM ${targets} WHERE workspace_id=$1 AND location_id IS NOT DISTINCT FROM $2 AND class=$3`,args);
        await audit.record(c,ctx,{action:'Removed safety stock target',reference:locationId||ctx.workspaceId,
          before:{class:cls,locationId,percent:prior.service_level==null?null:Number(prior.service_level),runoutsPerYear:prior.runouts_per_year==null?null:Number(prior.runouts_per_year)}});
      }
      return {removed:true};
    }
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    if(locationId&&!(await c.query('SELECT 1 FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL FOR SHARE',[ctx.workspaceId,locationId])).rowCount)
      throw new ValidationError('Choose an active location from this inventory.');
    // The page sends one number with the kind of target; callers may name it.
    let percent=null,runouts=null;
    if(input.kind==='runouts'){
      const raw=String(input.runouts??input.value??'').trim();
      runouts=Number(raw);
      if(!/^\d{1,2}(\.\d)?$/.test(raw)||!(runouts>0)||runouts>52)throw new ValidationError('Choose how many times a year you can run out, from 0.1 to 52.');
    }else{
      const raw=String(input.percent??input.value??'').trim();
      percent=Number(raw);
      if(!/^\d{2}(\.\d)?$/.test(raw)||percent<50||percent>99.9)throw new ValidationError('Choose a percentage from 50 to 99.9.');
    }
    const number=v=>v==null?null:Number(v);
    if(prior&&prior.authorized_by===ctx.actorId&&number(prior.service_level)===percent&&number(prior.runouts_per_year)===runouts)return {saved:false};
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?0:1);
    const revision=newId('service');
    await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'safety-target:'+revision,2048,{finished:true});
    if(prior)await c.query(`UPDATE ${targets} SET service_level=$4,runouts_per_year=$5,revision=$6,authorized_by=$7,updated_at=now()
      WHERE workspace_id=$1 AND location_id IS NOT DISTINCT FROM $2 AND class=$3`,[...args,percent,runouts,revision,ctx.actorId]);
    else await c.query(`INSERT INTO ${targets}(workspace_id,location_id,class,service_level,runouts_per_year,revision,authorized_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [...args,percent,runouts,revision,ctx.actorId]);
    await audit.record(c,ctx,{action:'Set safety stock target',reference:locationId||ctx.workspaceId,
      before:prior?{class:cls,locationId,percent:prior.service_level==null?null:Number(prior.service_level),runoutsPerYear:prior.runouts_per_year==null?null:Number(prior.runouts_per_year)}:{},
      after:{class:cls,locationId,percent,runoutsPerYear:runouts}});
    return {saved:true};
  });
}

async function page(db,ctx,{number=1}={}){
  const who=await member(db,ctx);
  const auth=await authority(db,ctx.workspaceId);
  if(!auth.plan)policy.requireJob(policy.usesAgentTerms(auth.account)?auth.account.plan:null,JOB,'draft');
  number=Number(number);
  if(!Number.isSafeInteger(number)||number<1||number>100000)throw new ValidationError('Choose a valid page.');
  const select=`SELECT c.*,c.before_safety::text,c.after_safety::text,c.change_percent::text FROM ${changes} c WHERE c.workspace_id=$1`;
  const drafts=(await db.query(select+` AND c.status='DRAFT' ORDER BY c.created_at DESC,c.id LIMIT 51 OFFSET $2`,[ctx.workspaceId,(number-1)*50])).rows;
  const shown=(await db.query(select+` AND c.status='WATCHED' ORDER BY c.evidence->>'code',c.evidence->>'location',c.id LIMIT 100`,[ctx.workspaceId])).rows;
  const held=(await db.query(select+` AND c.status='HELD' ORDER BY c.evidence->>'code',c.evidence->>'location',c.id LIMIT 100`,[ctx.workspaceId])).rows;
  const history=(await db.query(select+` AND c.status IN ('APPLIED','UNDONE','DECLINED') ORDER BY coalesce(c.undone_at,c.decided_at,c.created_at) DESC,c.id LIMIT 50`,[ctx.workspaceId])).rows;
  const applied=history.filter(r=>r.status==='APPLIED'&&r.policy_id);
  const policies=new Map(applied.length?(await db.query('SELECT id,safety_stock::text FROM reorder_policies WHERE workspace_id=$1 AND id=ANY($2::text[])',
    [ctx.workspaceId,applied.map(r=>r.policy_id)])).rows.map(r=>[r.id,r]):[]);
  for(const r of applied){const p=policies.get(r.policy_id);r.undoable=Boolean(p)&&amount(p.safety_stock)===amount(r.after_safety);}
  const run=(await db.query('SELECT started_at,finished_at FROM stockchief_runtime.agent_demand_forecast_runs WHERE workspace_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1',
    [ctx.workspaceId])).rows[0]||null;
  const isOwner=who.role==='owner'&&await base.ownerUser(db,ctx.workspaceId)===ctx.actorId;
  const locations=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL ORDER BY lower(name),id LIMIT 200',
    [ctx.workspaceId])).rows;
  return {plan:auth.plan,level:auth.level,reason:auth.reason,targets:await targetRows(db,ctx.workspaceId),rule:await changeLimit(db,ctx.workspaceId),run,
    drafts:drafts.slice(0,50),more:drafts.length>50,number,shown,held,history,isOwner,locations,targetWords};
}

// Needs you: values waiting for a person.
async function inbox(db,workspaceId){
  if(!await installed.has(db,changes))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return [];
  const row=(await db.query(`SELECT count(*)::int AS n,min(created_at) AS at FROM ${changes} WHERE workspace_id=$1 AND status='DRAFT'`,[workspaceId])).rows[0];
  if(!row.n)return [];
  return [{kind:'inventory',importance:'Needs You',priority:45,grouped:true,title:'Safety stock changes wait for you',
    happened:row.n+(row.n===1?' product and location has':' products and locations have')+' a new safety stock for your target.',
    why:'Safety stock covers sales swings and late deliveries for how often you can afford to run out. The reorder point builds on it.',
    recommendation:'Approve the new values, or keep the current ones.',href:href+'#waiting',actionLabel:'Review safety stock',
    sourceId:'safety-stock',at:row.at,createdAt:row.at}];
}

// Job 15's product page: the same calculation for one position, at the
// saved class target or a percentage entered for review. Nothing is saved.
async function classPlanning(db,ctx,itemId,input){
  const product=await abc.productForPlanning(db,ctx,itemId);
  const pageNumber=Number(input.page||1);
  if(!Number.isSafeInteger(pageNumber)||pageNumber<1||pageNumber>1000000)throw new ValidationError('Choose a valid results page.');
  const saved=await targetRows(db,ctx.workspaceId);
  const {rows}=await db.query(`WITH variants AS MATERIALIZED (
    SELECT id,code FROM skus WHERE workspace_id=$1 AND item_id=$2 AND is_active=1
  ), positions AS (
    SELECT b.sku_id,b.location_id FROM balances b JOIN variants s ON s.id=b.sku_id WHERE b.workspace_id=$1
    UNION
    SELECT p.sku_id,p.location_id FROM reorder_policies p JOIN variants s ON s.id=p.sku_id WHERE p.workspace_id=$1 AND p.location_id IS NOT NULL
  ) SELECT s.id AS sku_id,s.code,l.id AS location_id,l.name AS location,p.safety_stock
    FROM positions x JOIN variants s ON s.id=x.sku_id
    JOIN locations l ON l.workspace_id=$1 AND l.id=x.location_id AND l.is_active=1 AND l.custody_agreement_id IS NULL
    LEFT JOIN reorder_policies p ON p.workspace_id=$1 AND p.sku_id=s.id AND p.location_id=l.id
    ORDER BY lower(s.code),s.id,lower(l.name),l.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,itemId,(pageNumber-1)*100]);
  for(const r of rows){const g=saved.find(t=>t.class===product.category&&t.location_id===r.location_id)||saved.find(t=>t.class===product.category&&t.location_id==null);
    r.target=g?targetWords(g):null;r.goal=g||null;}
  const positions=rows.slice(0,100),model={product,positions,page:pageNumber,more:rows.length>100,selected:null,result:null,hold:null};
  if(!input.position)return model;
  const selected=positions.find(p=>JSON.stringify([p.sku_id,p.location_id])===input.position);
  if(!selected)throw new ValidationError('Choose a SKU and location from this product’s current page.');
  model.selected=selected;
  if(!['A','B','C'].includes(product.category)){
    model.hold='A verified current ABC class is needed for class-based safety planning.';
    return model;
  }
  let goal=selected.goal;
  if(input.serviceLevel!=null&&String(input.serviceLevel).trim()!==''){
    const percent=Number(input.serviceLevel);
    if(!Number.isFinite(percent)||percent<50||percent>99.9)throw new ValidationError('Choose a percentage from 50 to 99.9.');
    goal={class:product.category,location_id:selected.location_id,percent,runouts:null};
  }
  if(!goal)return model;
  const found=(await evaluate(db,ctx.workspaceId,[selected.sku_id],{goals:[{...goal,class:product.category,location_id:selected.location_id}]}))
    .find(p=>p.locationId===selected.location_id);
  if(!found)model.hold='This position has no stock, sales or own setting to plan from.';
  else if(found.hold)model.hold=found.hold;
  else model.result={units:Number(found.estimate.after),...found.estimate.evidence};
  return model;
}

base.addStep(step);
base.addInbox(inbox);

module.exports={JOB,CAPABILITY,href,zFor,authority,evaluate,position,step,approve,approveAll,decline,undo,setTarget,page,inbox,classPlanning};
