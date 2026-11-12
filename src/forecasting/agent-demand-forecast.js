'use strict';

// Job 144: forecasts demand for each item, with seasons.
//
// A daily worker run forecasts every active product from its own recorded
// sales: confirmed customer orders (channel orders included) by order date,
// plus sales recorded only as stock leaving. Each product's history is tested
// on held-out days against plain averages, a damped trend, a weekday pattern
// and, with a year of history, a yearly and weekday pattern; the winner is
// saved as a small shape that gives the same numbers again for any date.
//
// On Growth, Pro and Custom a saved forecast drives planning on its own: the
// reorder list and the daily reorder point check (job 21) use it in place of
// the flat 90-day rate. Ask me first, a pause or routine work being off keep
// each forecast waiting for the owner; Watch only and the first 14 days only
// show it. The owner can keep any product on plain sales history instead.
// Starter gets one suggestion. Weekly forecasts are kept and scored against
// what then sold, so forecast against actual is always on record.
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const queue=require('../operations/postgres-job-queue');
const permissions=require('../actions/permissions');
const installed=require('../db/schema-installed');
const time=require('../lib/business-time');
const models=require('./models');
const {evaluate}=require('./backtest');
const {addDays}=require('../accounting/customer-money');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const decision=require('../purchasing/replenishment-decision');

const JOB=144,KIND='planning.demand-forecast.v1',CAPABILITY='planning.demand_forecast',href='/planning/forecasts',PAGE=100;
const runs='stockchief_runtime.agent_demand_forecast_runs',forecasts='stockchief_runtime.agent_demand_forecasts';
const MODEL_VERSION='agent-144-v1',HISTORY_DAYS=1096,RECORD_DAYS=7,KEEP_RECORDS=730,APPROVAL_TOLERANCE=0.1,MAX_PLANNING_DAYS=730;
const CANDIDATES=[...models.ALL,models.yearlySeasonal()];
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
const round=(n,places=2)=>Math.round(n*10**places)/10**places;
const number=v=>v==null?null:Number(v);

async function ownerUser(db,workspaceId,lock=false){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL)
    ORDER BY u.created_at,u.id LIMIT 1${lock?' FOR SHARE OF u,w':''}`,[workspaceId])).rows[0]?.id||null;
}
async function member(db,ctx,action='review forecasts'){
  const row=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Choose an inventory you can access.');
  permissions.assertCan(row,permissions.MANAGE_REPLENISHMENT,action);
  return row;
}

// How far one forecasting job may go right now. Shared by jobs 144, 146 and
// 148, each with its own plan mode and owner job mode.
//   suggest  the plan only suggests
//   watch    Watch only or the first 14 days: shown, never used
//   draft    Ask me first, a pause or routine work off: waits for the owner
//   alone    used for planning on its own
async function authority(db,workspaceId,{job=JOB,capability=CAPABILITY,account=null}={}){
  account=account||await policy.accountState(db,workspaceId);
  const plan=policy.usesAgentTerms(account)?account.plan:null;
  if(!plan||!policy.permits(plan,job,'suggest'))return {plan:null,level:null,account};
  if(!policy.permits(plan,job,'automatic'))return {plan,level:'suggest',account};
  const watch=await policy.stopped(db,workspaceId,account,capability,false);
  if(watch)return {plan,level:'watch',reason:watch,account};
  let hold=await policy.stopped(db,workspaceId,account,capability,true);
  if(!hold&&!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
    hold='Routine work is off. Choose Handle routine work in StockChief AI to let forecasts drive planning on their own.';
  return {plan,level:hold?'draft':'alone',reason:hold||null,account};
}

// Recorded customer demand per product and business day: confirmed orders by
// order date, including channel orders, plus sales recorded only as stock
// leaving. A shipped order is the same demand as the order, so its stock
// movement is not counted again. Today is left out because it is not over.
async function demand(db,workspaceId,skuIds,{from,today}){
  const result=new Map(skuIds.map(id=>[id,new Map()]));
  if(!skuIds.length)return result;
  const {timeZone}=await time.forWorkspace(db,workspaceId);
  const {rows}=await db.query(`SELECT sku_id,day,sum(units)::float8 AS units FROM (
      SELECT l.sku_id,left(o.order_date,10) AS day,l.quantity_ordered::numeric AS units FROM sales_order_lines l
      JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
      WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND o.status NOT IN ('DRAFT','CANCELLED')
        AND left(o.order_date,10)>=$3 AND left(o.order_date,10)<$4
      UNION ALL
      SELECT d.sku_id,(d.occurred_at AT TIME ZONE $5)::date::text,d.issued FROM stockchief_runtime.replenishment_demand_events d
      JOIN movements m ON m.workspace_id=d.workspace_id AND m.id=d.movement_id
      WHERE d.workspace_id=$1 AND d.sku_id=ANY($2::text[]) AND d.occurred_at>=$6::timestamptz AND d.occurred_at<$7::timestamptz
        AND m.operation='issue' AND m.reason_code IN ('sale','sold')
        AND NOT EXISTS(SELECT 1 FROM sales_orders o WHERE o.workspace_id=m.workspace_id AND o.order_number=m.reference)
    ) recorded WHERE units>0 GROUP BY sku_id,day`,
  [workspaceId,skuIds,from,today,timeZone,time.dayBoundary(from,timeZone),time.dayBoundary(today,timeZone)]);
  for(const r of rows)result.get(r.sku_id)?.set(r.day,Number(r.units));
  return result;
}

// Complete calendar days from the first recorded sale to yesterday.
function daysOf(sales,today){
  const first=[...sales.keys()].sort()[0];
  const days=[];
  if(first)for(let date=first;date<today;date=addDays(date,1))days.push({date,demand:sales.get(date)||0});
  return days;
}

// The held-out comparison picks the method; the winner is then fitted on the
// whole history so the forecast starts from the latest sales.
function fit(days){
  const tested=evaluate(days,{models:CANDIDATES});
  const model=CANDIDATES.find(m=>m.id===tested.chosenId);
  const fitted=model?.fit(days)||null;
  const compared=(tested.results||[]).map(r=>({method:r.id,label:r.label,fitted:r.fitted,error:r.mae??null}));
  if(!fitted)return {method:null,label:'More history needed',days:days.length,compared};
  return {method:model.id,label:model.label,shape:fitted.shape,days:days.length,mae:tested.detail?.mae??null,
    baselineMae:tested.baseline?.mae??null,relative:tested.detail?.relative??null,reason:tested.reason||null,ran:tested.ran,compared};
}
function units(shape,from,days){
  let total=0;
  for(let i=0;i<days;i++)total+=models.rateFor(shape,addDays(from,i));
  return round(total);
}
async function historyStart(db,workspaceId,today){
  const {salesFrom}=await require('../commercial/agent-history').access(db,workspaceId);
  const earliest=addDays(today,-HISTORY_DAYS);
  return salesFrom&&salesFrom>earliest?salesFrom:earliest;
}

function decide(auth,before,f,next30){
  if(before?.excluded_at)return {status:'EXCLUDED',reason:'You chose plain sales history for this product.'};
  if(!f.shape)return {status:'HELD',reason:'Record more sales before forecasting this product.'};
  if(auth.level==='watch')return {status:'WATCHED',reason:auth.reason};
  if(auth.level==='draft'){
    const approved=before?.approved_method===f.method&&before.approved_next_30!=null&&
      Math.abs(next30-Number(before.approved_next_30))<=APPROVAL_TOLERANCE*Math.max(Number(before.approved_next_30),1);
    return approved?{status:'USED',reason:null}:{status:'PROPOSED',reason:auth.reason};
  }
  return {status:'USED',reason:null};
}

// One worker page of products: fit, save, record the weekly forecast and
// score earlier weekly forecasts whose week is over.
async function forecastPage(c,ctx,auth,run,skuIds,today){
  const counts={used:0,proposed:0,watched:0,excluded:0,held:0};
  if(!skuIds.length)return counts;
  const workspaceId=ctx.workspaceId,from=await historyStart(c,workspaceId,today);
  const sales=await demand(c,workspaceId,skuIds,{from,today});
  const prior=new Map((await c.query(`SELECT *,next_30::float8 AS next_30,approved_next_30::float8 AS approved_next_30 FROM ${forecasts}
    WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) FOR UPDATE`,[workspaceId,skuIds])).rows.map(r=>[r.sku_id,r]));
  const latest=new Map((await c.query(`SELECT sku_id,max(as_of) AS as_of FROM demand_forecasts WHERE workspace_id=$1 AND sku_id=ANY($2::text[])
    AND model_version=$3 AND location_id IS NULL GROUP BY sku_id`,[workspaceId,skuIds,MODEL_VERSION])).rows.map(r=>[r.sku_id,r.as_of]));
  const changed=[];
  for(const skuId of skuIds){
    const history=sales.get(skuId),before=prior.get(skuId),days=daysOf(history,today);
    if(!days.length){
      if(before&&!before.excluded_at)await c.query(`DELETE FROM ${forecasts} WHERE workspace_id=$1 AND sku_id=$2`,[workspaceId,skuId]);
      continue;
    }
    const f=fit(days),next7=f.shape?units(f.shape,today,7):null,next30=f.shape?units(f.shape,today,30):null;
    const {status,reason}=decide(auth,before,f,next30);
    const evidence={from,first:days[0].date,compared:f.compared,reason:f.reason||null,tested:f.ran===true};
    await c.query(`INSERT INTO ${forecasts}(workspace_id,sku_id,run_id,as_of,status,reason,method,method_label,shape,next_7,next_30,
      holdout_error,baseline_error,history_days,order_days,evidence,excluded_by,excluded_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,now())
      ON CONFLICT(workspace_id,sku_id) DO UPDATE SET run_id=EXCLUDED.run_id,as_of=EXCLUDED.as_of,status=EXCLUDED.status,reason=EXCLUDED.reason,
        method=EXCLUDED.method,method_label=EXCLUDED.method_label,shape=EXCLUDED.shape,next_7=EXCLUDED.next_7,next_30=EXCLUDED.next_30,
        holdout_error=EXCLUDED.holdout_error,baseline_error=EXCLUDED.baseline_error,history_days=EXCLUDED.history_days,
        order_days=EXCLUDED.order_days,evidence=EXCLUDED.evidence,updated_at=now()`,
    [workspaceId,skuId,run.id,today,status,reason,f.method,f.label,f.shape?JSON.stringify(f.shape):null,next7,next30,
      f.mae??null,f.baselineMae??null,days.length,[...history.values()].length,JSON.stringify(evidence),before?.excluded_by||null,before?.excluded_at||null]);
    counts[status.toLowerCase()]++;
    const wasUsed=before?.status==='USED';
    if(status==='USED'?!wasUsed||before.method!==f.method||Math.round(before.next_30)!==Math.round(next30):wasUsed)
      changed.push({skuId,before:wasUsed?{method:before.method,next30:before.next_30}:null,after:status==='USED'?{method:f.method,next30}:{status}});
    if(f.shape&&(!latest.get(skuId)||latest.get(skuId)<=addDays(today,-RECORD_DAYS))){
      const relative=f.relative,confidence=days.length<90?'learning':relative!=null&&relative<=0.3?'high':'moderate';
      await c.query(`INSERT INTO demand_forecasts(id,workspace_id,sku_id,location_id,as_of,horizon_days,horizon_end,daily_rate,horizon_units,
        committed_units,confidence,model_id,model_version,evidence,backtest,calculation,created_at)
        VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$8,0,$9,$10,$11,$12,$13,'[]',$14)
        ON CONFLICT(workspace_id,sku_id,as_of) WHERE model_version='agent-144-v1' AND location_id IS NULL DO NOTHING`,
      [newId('forecast'),workspaceId,skuId,today,RECORD_DAYS,addDays(today,RECORD_DAYS-1),round(next7/RECORD_DAYS,4),next7,confidence,f.method,MODEL_VERSION,
        JSON.stringify({shape:f.shape,historyDays:days.length,status}),JSON.stringify({error:f.mae??null,baselineError:f.baselineMae??null,reason:f.reason||null}),nowIso()]);
    }
  }
  // Score each weekly forecast once its week is over, against the same
  // recorded sales the forecast was made from.
  const due=(await c.query(`SELECT f.id,f.sku_id,f.as_of,f.horizon_end,f.horizon_units::float8 AS predicted FROM demand_forecasts f
    WHERE f.workspace_id=$1 AND f.sku_id=ANY($2::text[]) AND f.model_version=$3 AND f.location_id IS NULL AND f.horizon_end<$4
      AND NOT EXISTS(SELECT 1 FROM forecast_outcomes o WHERE o.workspace_id=f.workspace_id AND o.forecast_id=f.id)`,[workspaceId,skuIds,MODEL_VERSION,today])).rows;
  for(const r of due){
    if(r.as_of<from)continue;
    let actual=0;
    for(let day=r.as_of;day<=r.horizon_end;day=addDays(day,1))actual+=sales.get(r.sku_id)?.get(day)||0;
    const error=r.predicted==null?null:round(r.predicted-actual,4);
    await c.query(`INSERT INTO forecast_outcomes(id,workspace_id,forecast_id,sku_id,scored_at,predicted_units,actual_units,error_units,absolute_error,
      censored_days,comparable,notes,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,1,$10,$5) ON CONFLICT(workspace_id,forecast_id) DO NOTHING`,
    [newId('outcome'),workspaceId,r.id,r.sku_id,nowIso(),r.predicted,round(actual,4),error,error==null?null:Math.abs(error),
      'Scored against confirmed orders and recorded sales.']);
  }
  await c.query(`DELETE FROM demand_forecasts WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND model_version=$3 AND location_id IS NULL AND as_of<$4`,
    [workspaceId,skuIds,MODEL_VERSION,addDays(today,-KEEP_RECORDS)]);
  if(changed.length)await audit.record(c,ctx,{action:'Updated demand forecasts used for planning',reference:run.id,
    before:{products:changed.map(x=>({skuId:x.skuId,...x.before}))},after:{products:changed.map(x=>({skuId:x.skuId,...x.after})),level:auth.level,runId:run.id}});
  return counts;
}

// Later jobs add their own step to each page of products, their own part of
// the forecasts page and their own Needs you items.
const steps=[],sections=[],inboxes=[];
function addStep(step){steps.push(step);}
function addSection(section){sections.push(section);}
function addInbox(inbox){inboxes.push(inbox);}
async function extraSections(db,ctx,auth){const model={};for(const section of sections)Object.assign(model,await section(db,ctx,auth));return model;}

// One worker page: up to 100 active products. A finished run, or a page this
// run already passed, is not processed again.
async function process(c,workspaceId,payload={}){
  const runKey=String(payload.runKey||'');
  if(!runKey||runKey.length>80)throw Object.assign(new ValidationError('A forecast run needs its run key.'),{retryable:false});
  await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[workspaceId]);
  const account=await policy.accountState(c,workspaceId);
  const auth=await authority(c,workspaceId,{account});
  if(!auth.plan||auth.level==='suggest')return {skipped:'plan'};
  const actorId=await ownerUser(c,workspaceId,true);
  if(!actorId)return {skipped:'owner'};
  const ctx={workspaceId,actorId},today=await time.today(c,workspaceId);
  let run=(await c.query(`INSERT INTO ${runs}(id,workspace_id,run_key,business_date,plan,level,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(workspace_id,run_key) DO NOTHING RETURNING *`,[newId('forecast-run'),workspaceId,runKey,today,auth.plan,auth.level,payload.requestedBy||null])).rows[0];
  if(run)await c.query(`DELETE FROM ${runs} WHERE workspace_id=$1 AND id<>$2 AND started_at<now()-interval '90 days'`,[workspaceId,run.id]);
  else run=(await c.query(`SELECT * FROM ${runs} WHERE workspace_id=$1 AND run_key=$2 FOR UPDATE`,[workspaceId,runKey])).rows[0];
  const after=payload.afterSkuId||null;
  if(run.finished_at||(run.cursor&&(!after||after<run.cursor)))return {runId:run.id,replayed:true};
  const ids=(await c.query(`SELECT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    WHERE s.workspace_id=$1 AND s.is_active=1 AND ($2::text IS NULL OR s.id>$2) ORDER BY s.id LIMIT $3`,[workspaceId,after,PAGE+1])).rows.map(r=>r.id);
  const page=ids.slice(0,PAGE);
  if(page.length)await require('../commercial/storage-capacity').reserve(c,workspaceId,'demand-forecast:'+run.id+':'+(after||'start'),page.length*2048+4096,{finished:true});
  const counts=await forecastPage(c,ctx,auth,run,page,today);
  for(const step of steps)Object.assign(counts,await step(c,ctx,{run,skuIds:page,today,account}));
  const total={...run.counts};
  for(const [name,n] of Object.entries(counts))total[name]=Number(total[name]||0)+n;
  const more=ids.length>PAGE;
  await c.query(`UPDATE ${runs} SET counts=$3::jsonb,cursor=coalesce($4,cursor),finished_at=CASE WHEN $5 THEN NULL ELSE now() END WHERE workspace_id=$1 AND id=$2`,
    [workspaceId,run.id,JSON.stringify(total),page.at(-1)||null,more]);
  if(more)await queue.enqueue(scoped(c),{workspaceId,kind:KIND,idempotencyKey:'demand-forecast:'+runKey+':'+page.at(-1),
    payload:{runKey,afterSkuId:page.at(-1),requestedBy:payload.requestedBy||null},priority:64,maxAttempts:3});
  return {runId:run.id,level:auth.level,...counts,more};
}

// Called on the first page of each scheduled autopilot check: one run a
// business day, queued ahead of the daily reorder point check.
async function schedule(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic'))return {queued:false};
  const day=await time.today(db,workspaceId);
  return {queued:(await queue.enqueue(db,{workspaceId,kind:KIND,idempotencyKey:'demand-forecast:'+day,payload:{runKey:day},priority:64,maxAttempts:3})).created};
}
async function requestCheck(db,ctx){
  await member(db,ctx,'refresh forecasts');
  const account=await policy.accountState(db,ctx.workspaceId);
  policy.requireJob(policy.usesAgentTerms(account)?account.plan:null,JOB,'automatic');
  const slot=Math.floor(Date.now()/900000);
  const job=await queue.enqueue(db,{workspaceId:ctx.workspaceId,kind:KIND,idempotencyKey:'demand-forecast:manual:'+slot,
    payload:{runKey:'manual-'+slot,requestedBy:ctx.actorId},priority:60,maxAttempts:3});
  return {queued:job.created};
}

async function current(c,ctx,skuId){
  const row=(await c.query(`SELECT f.*,f.next_30::float8 AS next_30,s.code FROM ${forecasts} f JOIN skus s ON s.workspace_id=f.workspace_id AND s.id=f.sku_id
    WHERE f.workspace_id=$1 AND f.sku_id=$2 FOR UPDATE OF f`,[ctx.workspaceId,String(skuId||'')])).rows[0];
  if(!row)throw new NotFoundError('That product has no forecast in this inventory.');
  return row;
}
// Ask me first: the owner lets a waiting forecast drive planning. It stays in
// use while later forecasts keep the same method and stay within 10%.
async function approveOne(c,ctx,auth,skuId){
  const row=await current(c,ctx,skuId);
  if(row.status==='USED'&&row.approved_by===ctx.actorId&&row.approved_method===row.method)return {skuId,replayed:true};
  if(row.status!=='PROPOSED')throw new ValidationError('This forecast is no longer waiting for approval.');
  await c.query(`UPDATE ${forecasts} SET status='USED',reason=NULL,approved_method=method,approved_next_30=next_30,approved_by=$3,approved_at=now(),updated_at=now()
    WHERE workspace_id=$1 AND sku_id=$2`,[ctx.workspaceId,row.sku_id,ctx.actorId]);
  await audit.record(c,ctx,{action:'Approved demand forecast for planning',reference:row.sku_id,before:{status:row.status},
    after:{code:row.code,method:row.method,next7:number(row.next_7),next30:row.next_30,asOf:row.as_of}});
  return {skuId:row.sku_id};
}
async function decisionAuthority(c,ctx){
  await member(c,ctx,'approve forecasts');
  const auth=await authority(c,ctx.workspaceId);
  policy.requireJob(auth.plan,JOB,'automatic');
  if(auth.level==='watch')throw new ValidationError(auth.reason);
  return auth;
}
async function approve(db,ctx,skuId){return tx(db,async c=>approveOne(c,ctx,await decisionAuthority(c,ctx),skuId));}
async function approveAll(db,ctx){
  return tx(db,async c=>{
    const auth=await decisionAuthority(c,ctx);
    const ids=(await c.query(`SELECT sku_id FROM ${forecasts} WHERE workspace_id=$1 AND status='PROPOSED' ORDER BY sku_id LIMIT 500`,[ctx.workspaceId])).rows;
    for(const r of ids)await approveOne(c,ctx,auth,r.sku_id);
    return {approved:ids.length};
  });
}
// The undo for "forecast drives planning": keep a product on plain sales
// history, or hand it back to the forecast.
async function setExcluded(db,ctx,input){
  return tx(db,async c=>{
    await member(c,ctx,'change forecast use');
    const auth=await authority(c,ctx.workspaceId);
    policy.requireJob(auth.plan,JOB,'automatic');
    const row=await current(c,ctx,input.skuId),exclude=input.excluded==='yes';
    if(exclude===(row.status==='EXCLUDED'))return {skuId:row.sku_id,replayed:true};
    const status=exclude?'EXCLUDED':!row.shape?'HELD':auth.level==='alone'?'USED':auth.level==='draft'?'PROPOSED':'WATCHED';
    const reason=exclude?'You chose plain sales history for this product.':status==='HELD'?'Record more sales before forecasting this product.':auth.reason||null;
    await c.query(`UPDATE ${forecasts} SET status=$3,reason=$4,excluded_by=$5,excluded_at=CASE WHEN $6 THEN now() END,updated_at=now()
      WHERE workspace_id=$1 AND sku_id=$2`,[ctx.workspaceId,row.sku_id,status,reason,exclude?ctx.actorId:null,exclude]);
    await audit.record(c,ctx,{action:exclude?'Kept a product on plain sales history':'Let the forecast plan a product again',reference:row.sku_id,
      before:{code:row.code,status:row.status},after:{code:row.code,status}});
    return {skuId:row.sku_id,status};
  });
}

// Planning feed. Rows are replenishment positions (product and location, or
// one row for all locations). A forecast in use gives each row its daily
// demand for the days planning needs, times that location's share of recent
// physical sales. Rows the forecast cannot split are left on sales history.
const feeds=[];
function addFeed(feed){feeds.push(feed);}
// Later feeds (new products, trends) take precedence over the product's own
// forecast, each only on plans where its job may act on its own.
async function attach(db,workspaceId,rows){
  if(!rows.length||!await installed.has(db,forecasts))return rows;
  const skuIds=[...new Set(rows.map(r=>r.sku_id))];
  const found=[...(await db.query(`SELECT sku_id,'HISTORY' AS basis,method,method_label AS label,shape FROM ${forecasts}
    WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND status='USED'`,[workspaceId,skuIds])).rows];
  for(const feed of feeds)found.push(...await feed(db,workspaceId,skuIds));
  if(!found.length)return rows;
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account))return rows;
  const sources=new Map(found.filter(r=>policy.permits(account.plan,r.job||JOB,'automatic')).map(r=>[r.sku_id,r]));
  const today=await time.today(db,workspaceId),bySku=new Map();
  for(const row of rows){if(!bySku.has(row.sku_id))bySku.set(row.sku_id,[]);bySku.get(row.sku_id).push(row);}
  for(const [skuId,list] of bySku){
    const source=sources.get(skuId);
    if(!source)continue;
    const sites=list.filter(r=>r.location_id&&r.scope!=='workspace');
    const total=sites.reduce((sum,r)=>sum+Number(r.issued||0),0);
    const horizon=Math.min(MAX_PLANNING_DAYS,Math.max(decision.SAFETY_DAYS,...list.map(r=>Math.ceil(Number(r.local_lead??r.lead_time_days??decision.DEFAULT_LEAD_DAYS))||0),
      ...list.map(r=>Number(r.cover_days??decision.COVER_DAYS)||0)));
    const daily=Array.from({length:horizon},(_,i)=>models.rateFor(source.shape,addDays(today,i))*(source.factor??1));
    for(const row of list){
      const share=!row.location_id||row.scope==='workspace'?1:total>0?Number(row.issued||0)/total:sites.length===1?1:null;
      if(share==null)continue;
      row.forecast={basis:source.basis,method:source.method,label:source.label,share:round(share,6),...(source.trend?{trend:source.trend}:{}),
        daily:daily.map(v=>v*share)};
    }
  }
  return rows;
}

async function lastWeeks(db,workspaceId,skuIds){
  if(!skuIds.length)return new Map();
  return new Map((await db.query(`SELECT DISTINCT ON (f.sku_id) f.sku_id,f.as_of,f.horizon_end,f.horizon_units::float8 AS predicted,o.actual_units::float8 AS actual
    FROM demand_forecasts f JOIN forecast_outcomes o ON o.workspace_id=f.workspace_id AND o.forecast_id=f.id
    WHERE f.workspace_id=$1 AND f.sku_id=ANY($2::text[]) AND f.model_version=$3 AND f.location_id IS NULL
    ORDER BY f.sku_id,f.as_of DESC`,[workspaceId,skuIds,MODEL_VERSION])).rows.map(r=>[r.sku_id,r]));
}
async function accuracy(db,workspaceId){
  const row=(await db.query(`SELECT count(*)::int AS n,round(avg(o.absolute_error)::numeric,2)::float8 AS error,
    round(sum(o.actual_units)::numeric,2)::float8 AS actual,round(sum(o.predicted_units)::numeric,2)::float8 AS predicted
    FROM forecast_outcomes o JOIN demand_forecasts f ON f.workspace_id=o.workspace_id AND f.id=o.forecast_id
    WHERE o.workspace_id=$1 AND f.model_version=$2 AND f.as_of>=$3`,[workspaceId,MODEL_VERSION,addDays(await time.today(db,workspaceId),-91)])).rows[0];
  return row.n?row:null;
}

const statusWords={USED:'Used for planning',PROPOSED:'Waiting for your approval',WATCHED:'Shown only',EXCLUDED:'Plain sales history',HELD:'More history needed'};

// The review page and Starter's single suggestion: the same calculation the
// daily run makes, for one page of products, with what the run decided.
async function review(db,ctx,{filter,page,today}){
  const selected=await db.query(`SELECT s.id,s.code,s.item_id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ($2='' OR lower(s.code)=lower($2))
    ORDER BY s.code,s.id LIMIT 26 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*25]);
  const skus=selected.rows.slice(0,25),ids=skus.map(s=>s.id),from=await historyStart(db,ctx.workspaceId,today);
  const sales=await demand(db,ctx.workspaceId,ids,{from,today});
  const saved=await installed.has(db,forecasts)?new Map((await db.query(`SELECT sku_id,status FROM ${forecasts} WHERE workspace_id=$1 AND sku_id=ANY($2::text[])`,
    [ctx.workspaceId,ids])).rows.map(r=>[r.sku_id,r.status])):new Map();
  const weeks=await lastWeeks(db,ctx.workspaceId,ids);
  const rows=skus.map(sku=>{
    const history=sales.get(sku.id),days=daysOf(history,today),f=fit(days),week=weeks.get(sku.id);
    return {SKU:sku.code,'Complete calendar days':days.length,'Order days':history.size,'Forecast method':f.label,
      'Next 7 days':f.shape?units(f.shape,today,7):null,'Next 30 days':f.shape?units(f.shape,today,30):null,'Holdout error (units/day)':f.mae??null,
      'Last full week forecast':week?round(week.predicted):null,'Last full week actual':week?round(week.actual):null,
      Planning:statusWords[saved.get(sku.id)]||'Not used yet',link:'/inventory/'+sku.item_id};
  });
  return {rows,more:selected.rows.length>25,summary:'Estimated units from confirmed customer orders and recorded sales. Each method is tested on held-out days against simpler forecasts; a yearly pattern needs a full year of history. The history excludes today.'};
}

async function page(db,ctx,{number=1}={}){
  const who=await member(db,ctx);
  const auth=await authority(db,ctx.workspaceId);
  if(!auth.plan)policy.requireJob(null,JOB,'suggest');
  number=Number(number);
  if(!Number.isSafeInteger(number)||number<1||number>100000)throw new ValidationError('Choose a valid page.');
  const today=await time.today(db,ctx.workspaceId);
  if(auth.level==='suggest'){
    const first=(await review(db,ctx,{filter:'',page:1,today})).rows.find(r=>r['Next 7 days']!=null);
    return {plan:auth.plan,level:auth.level,suggestion:first?{code:first.SKU,next7:first['Next 7 days'],method:first['Forecast method']}:null,forecasts:[],waiting:[],
      ...await extraSections(db,ctx,auth)};
  }
  const run=(await db.query(`SELECT * FROM ${runs} WHERE workspace_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1`,[ctx.workspaceId])).rows[0]||null;
  const select=`SELECT f.*,f.next_7::float8 AS next_7,f.next_30::float8 AS next_30,f.holdout_error::float8 AS holdout_error,s.code,i.name,i.unit_label
    FROM ${forecasts} f JOIN skus s ON s.workspace_id=f.workspace_id AND s.id=f.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE f.workspace_id=$1`;
  const list=(await db.query(select+` AND f.status<>'PROPOSED' ORDER BY f.status='USED' DESC,s.code,f.sku_id LIMIT 51 OFFSET $2`,[ctx.workspaceId,(number-1)*50])).rows;
  const waiting=(await db.query(select+` AND f.status='PROPOSED' ORDER BY s.code,f.sku_id LIMIT 100`,[ctx.workspaceId])).rows;
  const weeks=await lastWeeks(db,ctx.workspaceId,[...list,...waiting].map(r=>r.sku_id));
  for(const r of [...list,...waiting])r.week=weeks.get(r.sku_id)||null;
  return {plan:auth.plan,level:auth.level,reason:auth.reason,run,forecasts:list.slice(0,50),more:list.length>50,number,waiting,
    accuracy:await accuracy(db,ctx.workspaceId),isOwner:who.role==='owner',statusWords,...await extraSections(db,ctx,auth)};
}

// Needs you: forecasts waiting for the owner on Growth, Pro and Custom, then
// what the later forecasting jobs add.
async function inbox(db,workspaceId){
  const items=await ownInbox(db,workspaceId);
  for(const extra of inboxes)items.push(...await extra(db,workspaceId));
  return items;
}
async function ownInbox(db,workspaceId){
  if(!await installed.has(db,forecasts))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic'))return [];
  const row=(await db.query(`SELECT count(*)::int AS n,min(updated_at) AS at FROM ${forecasts} WHERE workspace_id=$1 AND status='PROPOSED'`,[workspaceId])).rows[0];
  if(!row.n)return [];
  return [{kind:'inventory',importance:'Needs You',priority:45,grouped:true,title:'Forecasts wait for your approval',
    happened:row.n+(row.n===1?' product forecast is':' product forecasts are')+' ready but not used for planning yet.',
    why:'Ask me first, a pause or routine work being off keeps forecasts out of planning until you approve them.',
    recommendation:'Approve the forecasts, or keep planning from plain sales history.',href:href+'#waiting',actionLabel:'Review forecasts',
    sourceId:'demand-forecasts',at:row.at,createdAt:row.at}];
}

module.exports={JOB,KIND,CAPABILITY,href,MODEL_VERSION,authority,demand,daysOf,fit,units,historyStart,ownerUser,member,process,schedule,requestCheck,
  approve,approveAll,setExcluded,attach,addStep,addFeed,addSection,addInbox,review,page,inbox,statusWords};

// Jobs 146 and 148 add their steps, feeds, page parts and Needs you items.
require('./agent-launch-forecast');
