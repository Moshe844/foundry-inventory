'use strict';

// Job 148: spots trends early, an item suddenly selling faster (or slower).
//
// Each product's last 14 complete days are compared with its own forecast:
// the method job 144 picks, fitted on the history before those days, so a
// season the product's yearly pattern expects is not a trend. A trend needs:
//   - at least six weeks of history before the 14 days;
//   - sales at least three standard deviations from the forecast, measured
//     from the product's own day-to-day swings and never tighter than chance;
//   - faster: at least 1.5 times the forecast, on three or more sale days;
//     slower: at most half the forecast, when a week's worth was expected.
// One order more than four times the usual order size is a one-off: it is left
// out and named. Two or more such orders count, because that is a pattern.
//
// On Growth, Pro and Custom the daily forecast run checks every product and
// a trend found goes to Needs you; planning then follows the recent level
// (seasons kept, up to four times or down to a quarter of the forecast) until
// the trend eases or a person dismisses it. Ask me first, a pause or routine
// work being off wait for approval; Watch only and the first 14 days only
// show it. Starter gets one suggestion. Trends are kept as planning
// recommendations, so every one says what it saw, who decided and what
// followed.
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const time=require('../lib/business-time');
const models=require('./models');
const base=require('./agent-demand-forecast');
const {addDays}=require('../accounting/customer-money');
const {ValidationError,NotFoundError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');

const JOB=148,CAPABILITY='planning.demand_trend',KIND='demand_trend',WINDOW=14,BASELINE=56,MIN_HISTORY=42,THRESHOLD=3,FASTER=1.5,SLOWER=0.5,
  BIG_ORDER=4,MIN_SALE_DAYS=3,MIN_EXPECTED_DROP=7,MAX_FACTOR=4,MIN_FACTOR=0.25,REVIEW_LIMIT=200,DECLINE_DAYS=28;
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const CANDIDATES=[...models.ALL,models.yearlySeasonal()];
const round=(n,places=2)=>Math.round(n*10**places)/10**places;
const parse=v=>{if(!v)return {};if(typeof v==='object')return v;try{return JSON.parse(v);}catch{return {};}};

// Individual sales in the window and the eight weeks before it: each
// confirmed order, and each sale recorded only as stock leaving.
async function events(db,workspaceId,skuIds,{from,today}){
  const result=new Map(skuIds.map(id=>[id,[]]));
  if(!skuIds.length)return result;
  const {timeZone}=await time.forWorkspace(db,workspaceId);
  const {rows}=await db.query(`SELECT sku_id,day,sum(units)::float8 AS units,min(label) AS label FROM (
      SELECT l.sku_id,left(o.order_date,10) AS day,l.quantity_ordered::numeric AS units,'order:'||o.id AS event,o.order_number AS label FROM sales_order_lines l
      JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
      WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND o.status NOT IN ('DRAFT','CANCELLED') AND left(o.order_date,10)>=$3 AND left(o.order_date,10)<$4
      UNION ALL
      SELECT d.sku_id,(d.occurred_at AT TIME ZONE $5)::date::text,d.issued,'stock:'||coalesce(nullif(m.reference,''),m.id),coalesce(nullif(m.reference,''),'Stock removal')
      FROM stockchief_runtime.replenishment_demand_events d JOIN movements m ON m.workspace_id=d.workspace_id AND m.id=d.movement_id
      WHERE d.workspace_id=$1 AND d.sku_id=ANY($2::text[]) AND d.occurred_at>=$6::timestamptz AND d.occurred_at<$7::timestamptz
        AND m.operation='issue' AND m.reason_code IN ('sale','sold')
        AND NOT EXISTS(SELECT 1 FROM sales_orders o WHERE o.workspace_id=m.workspace_id AND o.order_number=m.reference)
    ) recorded WHERE units>0 GROUP BY sku_id,day,event ORDER BY sku_id,day,event`,
  [workspaceId,skuIds,from,today,timeZone,time.dayBoundary(from,timeZone),time.dayBoundary(today,timeZone)]);
  for(const r of rows)result.get(r.sku_id)?.push({day:r.day,units:Number(r.units),label:r.label});
  return result;
}

function median(values){
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
}

// The trend test for one product. Returns null when there is no trend.
function detect(days,list,today){
  const start=addDays(today,-WINDOW),before=days.filter(d=>d.date<start);
  if(before.length<MIN_HISTORY)return null;
  // The method job 144 picks on the whole history, fitted on the days before
  // the window: a season the yearly pattern expects is not a trend.
  const chosen=base.fit(days),model=CANDIDATES.find(m=>m.id===chosen.method);
  const fitted=model?.fit(before),f=fitted?{shape:fitted.shape,method:model.id,label:model.label}:base.fit(before);
  if(!f.shape)return null;
  let expected=0;
  for(let i=0;i<WINDOW;i++)expected+=models.rateFor(f.shape,addDays(start,i));
  const recent=before.slice(-BASELINE).map(d=>d.demand),spread=models.stdev(recent);
  const usual=median(list.filter(e=>e.day<start&&e.day>=addDays(start,-BASELINE)).map(e=>e.units));
  const inWindow=list.filter(e=>e.day>=start);
  const big=usual==null?[]:inWindow.filter(e=>e.units>BIG_ORDER*usual&&e.units>=BIG_ORDER);
  const ignored=big.length===1?big:[];
  const counted=inWindow.filter(e=>!ignored.includes(e));
  const observed=counted.reduce((sum,e)=>sum+e.units,0),saleDays=new Set(counted.map(e=>e.day)).size;
  const sd=Math.sqrt(Math.max(WINDOW*spread*spread,expected,1)),z=(observed-expected)/sd;
  const faster=z>=THRESHOLD&&observed>=FASTER*expected&&saleDays>=MIN_SALE_DAYS;
  const slower=z<=-THRESHOLD&&observed<=SLOWER*expected&&expected>=MIN_EXPECTED_DROP;
  if(!faster&&!slower)return null;
  const factor=expected>0?Math.min(MAX_FACTOR,Math.max(MIN_FACTOR,observed/expected)):null;
  const shape=factor!=null?{kind:'scaled',factor,shape:f.shape}:{kind:'flat',rate:observed/WINDOW};
  return {direction:faster?'FASTER':'SLOWER',from:start,to:addDays(today,-1),observed:round(observed),expected:round(expected),z:round(z),
    saleDays,factor:factor==null?null:round(factor,4),usual:usual==null?null:round(usual),ignored:ignored.map(e=>({day:e.day,units:e.units,label:e.label})),
    method:f.method,label:f.label,shape,next30:base.units(shape,today,30)};
}

async function scan(db,workspaceId,skuIds,today){
  const from=await base.historyStart(db,workspaceId,today);
  const series=await base.demand(db,workspaceId,skuIds,{from,today});
  const sales=await events(db,workspaceId,skuIds,{from:addDays(today,-(WINDOW+BASELINE)),today});
  const found=new Map();
  for(const id of skuIds){const t=detect(base.daysOf(series.get(id),today),sales.get(id),today);if(t)found.set(id,t);}
  return found;
}

const words=t=>t.direction==='FASTER'?'selling faster':'selling slower';
function why(code,t){
  return code+' sold '+t.observed+' in the last '+WINDOW+' days against about '+t.expected+' expected from its own forecast ('+t.z+' standard deviations)'+
    (t.ignored.length?'. One large order ('+t.ignored[0].label+', '+t.ignored[0].units+') was left out as a one-off':'')+'.';
}

// One step of the daily forecast run: check this page's products, keep one
// current trend per product, and let planning follow it when allowed.
async function step(c,ctx,{run,skuIds,today,account}){
  const counts={trends_used:0,trends_waiting:0,trends_shown:0,trends_ended:0};
  if(!skuIds.length)return counts;
  const auth=await base.authority(c,ctx.workspaceId,{job:JOB,capability:CAPABILITY,account});
  if(!auth.plan||auth.level==='suggest')return counts;
  const found=await scan(c,ctx.workspaceId,skuIds,today);
  const active=new Map((await c.query(`SELECT r.*,s.code FROM planning_recommendations r JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id
    WHERE r.workspace_id=$1 AND r.kind=$2 AND r.sku_id=ANY($3::text[]) AND r.status IN ('OPEN','APPLIED') FOR UPDATE OF r`,[ctx.workspaceId,KIND,skuIds])).rows.map(r=>[r.sku_id,r]));
  const declined=new Set((await c.query(`SELECT sku_id||':'||(evidence::jsonb->>'direction') AS k FROM planning_recommendations WHERE workspace_id=$1 AND kind=$2
    AND sku_id=ANY($3::text[]) AND status='DECLINED' AND decided_at>=$4`,[ctx.workspaceId,KIND,skuIds,addDays(today,-DECLINE_DAYS)])).rows.map(r=>r.k));
  const codes=new Map((await c.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,skuIds])).rows.map(r=>[r.id,r.code]));
  const at=nowIso(),changed=[];
  for(const skuId of skuIds){
    const t=found.get(skuId),prior=active.get(skuId),code=codes.get(skuId);
    if(prior&&(!t||parse(prior.evidence).direction!==t.direction)){
      await c.query(`UPDATE planning_recommendations SET status='SUPERSEDED',updated_at=$3,resulting_detail=$4 WHERE workspace_id=$1 AND id=$2`,
        [ctx.workspaceId,prior.id,at,JSON.stringify({reason:t?'The trend turned the other way.':'Sales are back in line with the forecast.',on:today})]);
      counts.trends_ended++;
      if(prior.status==='APPLIED')changed.push({skuId,code,before:{direction:parse(prior.evidence).direction,factor:parse(prior.evidence).factor},after:{ended:true}});
    }
    if(!t||declined.has(skuId+':'+t.direction))continue;
    const status=auth.level==='alone'||(prior?.status==='APPLIED'&&parse(prior.evidence).direction===t.direction&&auth.level!=='watch'&&prior.decided_by_user_id)?'APPLIED':'OPEN';
    const verdict=status==='APPLIED'?'authorized':auth.level==='draft'?'needs_approval':'refused';
    const evidence={...t,run:run.id},detail={level:auth.level,reason:auth.reason||null};
    if(prior&&parse(prior.evidence).direction===t.direction){
      await c.query(`UPDATE planning_recommendations SET current_value=$3,recommended_value=$4,headline=$5,why=$6,evidence=$7,status=$8,authority_verdict=$9,
        authority_detail=$10,confidence=$11,updated_at=$12 WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,prior.id,t.expected,t.observed,code+' is '+words(t),why(code,t),JSON.stringify(evidence),status,verdict,JSON.stringify(detail),
        Math.abs(t.z)>=2*THRESHOLD?'high':'moderate',at]);
      if(status==='APPLIED'&&prior.status!=='APPLIED')changed.push({skuId,code,before:null,after:{direction:t.direction,factor:t.factor}});
      else if(status!=='APPLIED'&&prior.status==='APPLIED')changed.push({skuId,code,before:{direction:t.direction,factor:parse(prior.evidence).factor},after:{status,reason:auth.reason}});
    }else{
      await c.query(`INSERT INTO planning_recommendations(id,workspace_id,kind,subject_type,subject_id,sku_id,current_value,recommended_value,headline,why,
        confidence,evidence,capability,authority_verdict,authority_detail,status,idempotency_key,created_at,updated_at)
        VALUES($1,$2,$3,'sku',$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
      [newId('trend'),ctx.workspaceId,KIND,skuId,t.expected,t.observed,code+' is '+words(t),why(code,t),Math.abs(t.z)>=2*THRESHOLD?'high':'moderate',
        JSON.stringify(evidence),CAPABILITY,verdict,JSON.stringify(detail),status,'demand-trend:'+skuId+':'+t.direction+':'+today,at]);
      if(status==='APPLIED')changed.push({skuId,code,before:null,after:{direction:t.direction,factor:t.factor}});
    }
    counts[status==='APPLIED'?'trends_used':verdict==='needs_approval'?'trends_waiting':'trends_shown']++;
  }
  if(changed.length)await audit.record(c,ctx,{action:'Updated demand trends used for planning',reference:run.id,
    before:{products:changed.map(x=>({skuId:x.skuId,code:x.code,...x.before}))},after:{products:changed.map(x=>({skuId:x.skuId,code:x.code,...x.after})),level:auth.level}});
  return counts;
}

async function trend(c,ctx,id){
  const row=(await c.query(`SELECT r.*,s.code FROM planning_recommendations r JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id
    WHERE r.workspace_id=$1 AND r.id=$2 AND r.kind=$3 FOR UPDATE OF r`,[ctx.workspaceId,String(id||''),KIND])).rows[0];
  if(!row)throw new NotFoundError('That trend is not in this inventory.');
  return row;
}
// Ask me first: a person lets planning follow the trend.
async function approve(db,ctx,id){
  return tx(db,async c=>{
    await base.member(c,ctx,'approve trends');
    const auth=await base.authority(c,ctx.workspaceId,{job:JOB,capability:CAPABILITY});
    policy.requireJob(auth.plan,JOB,'automatic');
    if(auth.level==='watch')throw new ValidationError(auth.reason);
    const row=await trend(c,ctx,id);
    if(row.status==='APPLIED'&&row.decided_by_user_id===ctx.actorId)return {id:row.id,replayed:true};
    if(row.status!=='OPEN')throw new ValidationError('This trend is no longer waiting for approval.');
    const at=nowIso();
    await c.query(`UPDATE planning_recommendations SET status='APPLIED',authority_verdict='authorized',decided_by_user_id=$3,decided_at=$4,updated_at=$4
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,ctx.actorId,at]);
    const e=parse(row.evidence);
    await audit.record(c,ctx,{action:'Approved a demand trend for planning',reference:row.id,before:{status:row.status},
      after:{code:row.code,direction:e.direction,factor:e.factor,observed:e.observed,expected:e.expected}});
    return {id:row.id};
  });
}
// The undo: planning goes back to the forecast, and the same trend is not
// raised again for four weeks.
async function dismiss(db,ctx,id){
  return tx(db,async c=>{
    await base.member(c,ctx,'dismiss trends');
    const row=await trend(c,ctx,id);
    if(row.status==='DECLINED')return {id:row.id,replayed:true};
    if(!['OPEN','APPLIED'].includes(row.status))throw new ValidationError('This trend has already ended.');
    const at=nowIso();
    await c.query(`UPDATE planning_recommendations SET status='DECLINED',decided_by_user_id=$3,decided_at=$4,updated_at=$4,resulting_detail=$5
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,ctx.actorId,at,JSON.stringify({reason:'Dismissed by a person.',was:row.status})]);
    const e=parse(row.evidence);
    await audit.record(c,ctx,{action:'Dismissed a demand trend',reference:row.id,before:{code:row.code,status:row.status,direction:e.direction,factor:e.factor},
      after:{status:'DECLINED'}});
    return {id:row.id};
  });
}

// Planning feed: a trend in use replaces the forecast for planning, except
// for new products forecast from similar items and products the owner keeps
// on plain sales history.
async function feed(db,workspaceId,skuIds){
  const rows=(await db.query(`SELECT r.sku_id,r.evidence FROM planning_recommendations r WHERE r.workspace_id=$1 AND r.kind=$2 AND r.status='APPLIED'
    AND r.sku_id=ANY($3::text[])`,[workspaceId,KIND,skuIds])).rows;
  if(!rows.length)return [];
  const kept=new Set();
  const has=require('../db/schema-installed').has;
  if(await has(db,'stockchief_runtime.agent_demand_forecasts'))for(const r of (await db.query(`SELECT sku_id FROM stockchief_runtime.agent_demand_forecasts
    WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND status='EXCLUDED'`,[workspaceId,skuIds])).rows)kept.add(r.sku_id);
  if(await has(db,'stockchief_runtime.agent_launch_forecasts'))for(const r of (await db.query(`SELECT sku_id FROM stockchief_runtime.agent_launch_forecasts
    WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND status='USED'`,[workspaceId,skuIds])).rows)kept.add(r.sku_id);
  return rows.filter(r=>!kept.has(r.sku_id)).map(r=>{const e=parse(r.evidence);
    return {sku_id:r.sku_id,basis:'TREND',job:JOB,method:'recent_trend',label:e.direction==='FASTER'?'Selling faster lately':'Selling slower lately',
      shape:e.shape,trend:{direction:e.direction,factor:e.factor}};});
}

const statusWords={APPLIED:'Used for planning',OPEN:'Waiting for you'};

// The review page and Starter's single suggestion: the same test, live, on
// the products with the most sales in the last 14 days.
async function review(db,ctx,{filter,page,today}){
  const {timeZone}=await time.forWorkspace(db,ctx.workspaceId),start=addDays(today,-(WINDOW+BASELINE));
  const ids=(await db.query(`SELECT s.id,s.code,s.item_id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    WHERE s.workspace_id=$1 AND s.is_active=1 AND ($2='' OR lower(s.code)=lower($2))
      AND (EXISTS(SELECT 1 FROM sales_order_lines l JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
          WHERE l.workspace_id=s.workspace_id AND l.sku_id=s.id AND o.status NOT IN ('DRAFT','CANCELLED') AND left(o.order_date,10)>=$3)
        OR EXISTS(SELECT 1 FROM stockchief_runtime.replenishment_demand_events d WHERE d.workspace_id=s.workspace_id AND d.sku_id=s.id AND d.occurred_at>=$4::timestamptz))
    ORDER BY s.code,s.id LIMIT $5`,[ctx.workspaceId,filter,start,time.dayBoundary(start,timeZone),REVIEW_LIMIT])).rows;
  const found=await scan(db,ctx.workspaceId,ids.map(r=>r.id),today);
  const saved=new Map((await db.query(`SELECT sku_id,status FROM planning_recommendations WHERE workspace_id=$1 AND kind=$2 AND status IN ('OPEN','APPLIED')
    AND sku_id=ANY($3::text[])`,[ctx.workspaceId,KIND,[...found.keys()]])).rows.map(r=>[r.sku_id,r.status]));
  const rows=ids.filter(r=>found.has(r.id)).map(r=>{const t=found.get(r.id);
    return {SKU:r.code,Direction:t.direction==='FASTER'?'Faster':'Slower','Last 14 days':t.observed,Expected:t.expected,'Standard deviations':t.z,
      'One-off orders left out':t.ignored.map(e=>e.label+' ('+e.units+')').join(', ')||null,'Next 30 days at this pace':t.next30,
      Planning:statusWords[saved.get(r.id)]||'Not used',link:'/inventory/'+r.item_id};});
  return {rows:rows.slice((page-1)*100,page*100),more:rows.length>page*100,summary:'Each product\'s last '+WINDOW+' days against its own forecast from the history before them. A trend needs three standard deviations and, when faster, at least 1.5 times the forecast on three or more sale days. One unusually large order is left out as a one-off.'};
}

async function section(db,ctx,auth){
  if(!policy.permits(auth.plan,JOB,'automatic'))return {};
  const rows=(await db.query(`SELECT r.id,r.status,r.authority_verdict,r.authority_detail,r.evidence,r.why,r.created_at,r.decided_by_user_id,s.code,i.unit_label
    FROM planning_recommendations r JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE r.workspace_id=$1 AND r.kind=$2 AND r.status IN ('OPEN','APPLIED') ORDER BY r.status='OPEN' DESC,r.updated_at DESC,r.id LIMIT 100`,[ctx.workspaceId,KIND])).rows;
  return {trends:rows.map(r=>({...r,evidence:parse(r.evidence),detail:parse(r.authority_detail)}))};
}

// Needs you: trends found in the last week, and trends waiting for approval.
async function inbox(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic'))return [];
  const today=await time.today(db,workspaceId);
  const row=(await db.query(`SELECT count(*) FILTER(WHERE status='APPLIED' AND created_at>=$3)::int AS used,
    count(*) FILTER(WHERE status='OPEN' AND authority_verdict='needs_approval')::int AS waiting,
    count(*) FILTER(WHERE status='OPEN' AND authority_verdict='refused' AND created_at>=$3)::int AS shown,min(created_at) AS at
    FROM planning_recommendations WHERE workspace_id=$1 AND kind=$2 AND status IN ('OPEN','APPLIED')`,[workspaceId,KIND,addDays(today,-6)])).rows[0];
  const items=[];
  if(row.waiting)items.push({kind:'inventory',importance:'Needs You',priority:55,grouped:true,title:'Sales trends wait for your approval',
    happened:row.waiting+(row.waiting===1?' product is':' products are')+' selling much faster or slower than forecast.',
    why:'Ask me first, a pause or routine work being off keeps planning on the forecast until you approve the trend.',
    recommendation:'Let planning follow the trend, or dismiss it.',href:base.href+'#trends',actionLabel:'Review trends',sourceId:'demand-trend-approvals',at:row.at,createdAt:row.at});
  if(row.used||row.shown)items.push({kind:'inventory',importance:'Important',priority:54,grouped:true,title:'Products selling faster or slower',
    happened:(row.used+row.shown)+((row.used+row.shown)===1?' product changed pace':' products changed pace')+' in the last two weeks.',
    why:row.used?'Planning now follows the recent pace. Dismiss a trend to go back to the forecast.':'StockChief is only watching for now, so planning has not changed.',
    recommendation:'Check the reorder list for these products.',href:base.href+'#trends',actionLabel:'Review trends',sourceId:'demand-trends',at:row.at,createdAt:row.at});
  return items;
}

base.addStep(step);
base.addFeed(feed);
base.addSection(section);
base.addInbox(inbox);

module.exports={JOB,CAPABILITY,KIND,events,detect,scan,step,approve,dismiss,feed,review,inbox};
