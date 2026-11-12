'use strict';
// Job 87: checks prices match across channels and flags minimum advertised
// price (MAP) breaks.
//
// Each connected channel's recorded price for a mapped product comes from the
// connector: the price its last catalogue check recorded, and the verified
// price of any governed price synchronization at a location. It is compared
// with the current catalogue price and the owner's MAP terms; without a
// catalogue price, channels are compared with each other. An old or missing
// channel price is reported, never guessed.
//
// Changing a selling price always needs a person (PDF page 13), so this job
// only checks and flags. It never writes a price to a channel or the catalogue.
// Growth, Pro and Custom check on their own through the worker. Pause holds the
// check; Watch only, Ask me first and the first 14 days only watch.
const {ValidationError,AuthorizationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const audit=require('../operations/postgres-security-audit');
const storage=require('../commercial/storage-capacity');
const {hash}=require('./postgres-promotions');
const {newId}=require('../lib/util');

const JOB=87,ACTION='channel.price_check',KIND='channel.price-check.v1',href='/autopilot/reviews/channel-prices';
const STALE_MS=24*3600000,LIMIT=5000;
const tables={runs:'stockchief_runtime.agent_channel_price_runs',alerts:'stockchief_runtime.agent_channel_price_alerts'};
const FINDINGS={stale:'Refresh provider check',missing:'Provider price unavailable',mapCurrency:'MAP currency needs review',map:'Recorded price below MAP',
  catalogueCurrency:'Catalogue currency differs',catalogue:'Recorded price differs from catalogue',match:'Matches recorded catalogue price',
  channels:'Differs from other channels',channelsMatch:'Matches other channels',noCatalogue:'No catalogue price recorded'};
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(sql,args)=>c.query(sql,args),transaction:operation=>operation(c)});
const alone=state=>policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'automatic');
const parse=v=>{if(v&&typeof v==='object')return v;try{return JSON.parse(v);}catch{return null;}};

async function owner(db,ctx){
  if(!(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId])).rowCount)
    throw new AuthorizationError('Only the inventory owner can check channel prices.');
}
async function currentOwner(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.role='owner' ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}
function price(value){
  const amount=Number(value?.amount),currency=String(value?.currency||'');
  return value&&Number.isSafeInteger(amount)&&amount>=0&&/^[A-Z]{3}$/.test(currency)?{amount,currency}:null;
}
function when(at){const time=at?Date.parse(at):NaN;return Number.isFinite(time)?new Date(time).toISOString().slice(0,16).replace('T',' ')+' UTC':'Never';}
function shown(amount,currency){
  if(amount==null||!currency)return 'Unavailable';
  try{return money.format(amount,currency);}catch(error){if(error.code!=='validation_error')throw error;return 'Provider currency needs review';}
}

// Every recorded channel price for active, mapped products on active channels.
async function observations(db,workspaceId){
  const active=`c.status='connected' AND c.paused_at IS NULL AND coalesce(c.config::jsonb->>'syncDisabled','false')<>'true'`;
  // One after another: db may be a single transaction client.
  const listed=await db.query(`SELECT m.foundry_record_id sku_id,s.code,i.name product,c.id connector_id,c.display_name channel,e.provider_data,e.last_seen_at
      FROM connection_mappings m JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id
      JOIN connection_external_records e ON e.workspace_id=m.workspace_id AND e.connector_id=m.connector_id AND e.entity_type='sku' AND e.external_id=m.external_id AND e.selected=1
      JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.foundry_record_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE m.workspace_id=$1 AND m.entity_type='sku' AND ${active} AND s.is_active=1 AND i.is_active=1
      ORDER BY s.code,c.display_name,c.id,m.external_id LIMIT ${LIMIT+1}`,[workspaceId]);
  const verified=await db.query(`SELECT p.id,p.sku_id,s.code,i.name product,c.id connector_id,c.display_name channel,p.location_id,l.name location,p.baseline_provider,p.last_verified_at
      FROM connection_commerce_positions p JOIN workspace_connectors c ON c.workspace_id=p.workspace_id AND c.id=p.connector_id
      JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id
      WHERE p.workspace_id=$1 AND p.field='price' AND p.mode<>'off' AND ${active} AND p.provider_account_id=c.provider_account_id AND p.provider_type=c.provider_type
        AND s.is_active=1 AND i.is_active=1 ORDER BY s.code,c.display_name,p.id LIMIT ${LIMIT+1}`,[workspaceId]);
  if(listed.rows.length>LIMIT||verified.rows.length>LIMIT)return {problem:'More than 5,000 channel prices are recorded. StockChief checks them in one go and does not skip any; ask support to raise this limit.',rows:[]};
  const connectors=[...new Set(listed.rows.map(r=>r.connector_id))];
  const places=connectors.length?(await db.query(`SELECT m.connector_id,m.external_id,l.id,l.name FROM connection_mappings m JOIN locations l ON l.workspace_id=m.workspace_id AND l.id=m.foundry_record_id
    WHERE m.workspace_id=$1 AND m.entity_type='location' AND m.connector_id=ANY($2::text[])`,[workspaceId,connectors])).rows:[];
  const placeOf=new Map(places.map(p=>[p.connector_id+'|'+p.external_id,p])),now=Date.now(),rows=[];
  const governed=new Set(verified.rows.map(p=>p.connector_id+'|'+p.sku_id+'|'+p.location_id));
  // An unknown or unreadable check time counts as old.
  const fresh=at=>{const time=at instanceof Date?at.getTime():Date.parse(at);return Number.isFinite(time)&&now-time<=STALE_MS;};
  for(const r of listed.rows){
    const data=parse(r.provider_data)||{},base={skuId:r.sku_id,code:r.code,product:r.product,connectorId:r.connector_id,channel:r.channel,checkedAt:r.last_seen_at,fresh:fresh(r.last_seen_at),source:'Last catalogue check'};
    rows.push({...base,scope:'',where:'All locations',value:price(data.priceMoney),recorded:data.priceMoney!=null});
    for(const o of Array.isArray(data.locationPriceOverrides)?data.locationPriceOverrides:[]){
      const place=placeOf.get(r.connector_id+'|'+o.location_id);
      if(!place||!o.price_money||governed.has(r.connector_id+'|'+r.sku_id+'|'+place.id))continue;
      rows.push({...base,scope:place.id,where:place.name,value:price(o.price_money),recorded:true});
    }
  }
  for(const p of verified.rows){
    const value=parse(p.baseline_provider);
    rows.push({skuId:p.sku_id,code:p.code,product:p.product,connectorId:p.connector_id,channel:p.channel,scope:p.location_id,where:p.location,
      checkedAt:p.last_verified_at?new Date(p.last_verified_at).toISOString():null,fresh:fresh(p.last_verified_at),source:'Verified price sync',value:price(value),recorded:value!=null});
  }
  if(rows.length>LIMIT)return {problem:'More than 5,000 channel prices are recorded. StockChief checks them in one go and does not skip any; ask support to raise this limit.',rows:[]};
  return {rows,connectors:[...new Set([...connectors,...verified.rows.map(p=>p.connector_id)])]};
}

// Compare each recorded channel price with the catalogue, MAP terms and the other channels.
async function evaluate(db,workspaceId){
  const seen=await observations(db,workspaceId);if(seen.problem)return {problem:seen.problem,rows:[],complete:false};
  const ids=[...new Set(seen.rows.map(r=>r.skuId))];
  const catalogue=ids.length?await db.query(`SELECT DISTINCT ON (sku_id) sku_id,amount_minor,currency FROM sku_prices WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) ORDER BY sku_id,created_at DESC,id DESC`,[workspaceId,ids]):{rows:[]};
  const terms=ids.length?await db.query('SELECT sku_id,minimum_minor,currency FROM stockchief_runtime.channel_map_rules WHERE workspace_id=$1 AND sku_id=ANY($2::text[])',[workspaceId,ids]):{rows:[]};
  const list=new Map(catalogue.rows.filter(r=>r.amount_minor!=null).map(r=>[r.sku_id,{amount:Number(r.amount_minor),currency:r.currency}]));
  const map=new Map(terms.rows.map(r=>[r.sku_id,{amount:Number(r.minimum_minor),currency:r.currency}]));
  const usable=r=>r.fresh&&r.value;
  const rows=seen.rows.map(r=>{
    const out={...r,catalogue:list.get(r.skuId)||null,map:map.get(r.skuId)||null,kind:'OK',compared:null};
    if(!r.fresh)return {...out,kind:'REVIEW',finding:FINDINGS.stale};
    if(!r.value)return {...out,kind:'REVIEW',finding:FINDINGS.missing};
    const v=r.value;
    if(out.map&&out.map.currency!==v.currency)return {...out,kind:'REVIEW',finding:FINDINGS.mapCurrency};
    if(out.map&&v.amount<out.map.amount)return {...out,kind:'MAP_BREAK',finding:FINDINGS.map,compared:out.map.amount};
    if(out.catalogue){
      if(out.catalogue.currency!==v.currency)return {...out,kind:'REVIEW',finding:FINDINGS.catalogueCurrency};
      if(out.catalogue.amount!==v.amount)return {...out,kind:'MISMATCH',finding:FINDINGS.catalogue,compared:out.catalogue.amount};
      return {...out,finding:FINDINGS.match,compared:out.catalogue.amount};
    }
    const others=seen.rows.filter(o=>o!==r&&o.skuId===r.skuId&&usable(o)&&o.value.currency===v.currency);
    if(!others.length)return {...out,kind:'REVIEW',finding:FINDINGS.noCatalogue};
    const differ=others.find(o=>o.value.amount!==v.amount);
    return differ?{...out,kind:'MISMATCH',finding:FINDINGS.channels,compared:differ.value.amount}:{...out,finding:FINDINGS.channelsMatch,compared:others[0].value.amount};
  });
  return {rows,connectors:seen.connectors,complete:true};
}
const key=r=>r.skuId+'|'+r.connectorId+'|'+r.scope;
const label=r=>r.code+' on '+r.channel+(r.scope?' at '+r.where:'');

// Open, update and clear flags for one evaluation. The same facts replay to the same run.
async function record(c,ctx,evaluation,{automatic,watch=null}){
  const flagged=evaluation.rows.filter(r=>['MAP_BREAK','MISMATCH'].includes(r.kind)),review=evaluation.rows.filter(r=>r.kind==='REVIEW');
  const outcome=evaluation.problem?'STOPPED':watch?'WATCHED':'CHECKED';
  const runKey=hash({outcome,watch,automatic,problem:evaluation.problem||null,rows:evaluation.rows.map(r=>[key(r),r.kind,r.finding,r.value?.amount??null,r.value?.currency??null,r.compared])});
  await storage.reserve(scoped(c),ctx.workspaceId,'channel-price-run:'+runKey.slice(0,48),4096+evaluation.rows.length*160,{finished:true});
  const runId=newId('pricerun');
  const inserted=(await c.query(`INSERT INTO ${tables.runs}(workspace_id,id,run_key,outcome,reason,authorization_kind,result,created_by)
    VALUES($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7) ON CONFLICT(workspace_id,run_key) DO NOTHING RETURNING id`,
  [ctx.workspaceId,runId,runKey,outcome,evaluation.problem||watch,automatic?'AUTOMATIC':'INDIVIDUAL',automatic?null:ctx.actorId])).rows[0];
  if(!inserted){const prior=(await c.query(`SELECT id,result FROM ${tables.runs} WHERE workspace_id=$1 AND run_key=$2`,[ctx.workspaceId,runKey])).rows[0];
    return {replayed:true,runId:prior.id,outcome,opened:[],updated:[],cleared:[],...prior.result};}
  const summary={checked:evaluation.rows.length,mapBreaks:flagged.filter(r=>r.kind==='MAP_BREAK').length,mismatches:flagged.filter(r=>r.kind==='MISMATCH').length,
    review:review.length,reviewSample:review.slice(0,20).map(r=>({label:label(r),finding:r.finding})),flagged:flagged.slice(0,50).map(r=>({label:label(r),kind:r.kind,finding:r.finding}))};
  if(outcome!=='CHECKED'){
    const result={...summary,reason:evaluation.problem||watch,opened:[],updated:[],cleared:[]};
    await c.query(`UPDATE ${tables.runs} SET result=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,runId,JSON.stringify(result)]);
    return {runId,outcome,...result};
  }
  const open=(await c.query(`SELECT * FROM ${tables.alerts} WHERE workspace_id=$1 AND status='OPEN' ORDER BY id FOR UPDATE`,[ctx.workspaceId])).rows;
  const byKey=new Map(open.map(a=>[a.sku_id+'|'+a.connector_id+'|'+a.scope,a])),opened=[],updated=[],cleared=[];
  for(const r of flagged){
    const values=[r.kind,label(r),r.finding,r.value.amount,r.value.currency,r.compared,runId],existing=byKey.get(key(r));
    if(existing){
      if(existing.kind!==r.kind||existing.finding!==r.finding||Number(existing.channel_minor)!==r.value.amount||existing.currency!==r.value.currency||(existing.compared_minor==null?null:Number(existing.compared_minor))!==r.compared){
        await c.query(`UPDATE ${tables.alerts} SET kind=$3,label=$4,finding=$5,channel_minor=$6,currency=$7,compared_minor=$8,last_run_id=$9,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,existing.id,...values]);
        updated.push(existing.id);
      }
      continue;
    }
    const id=newId('pricealert');
    await c.query(`INSERT INTO ${tables.alerts}(workspace_id,id,sku_id,connector_id,scope,kind,label,finding,channel_minor,currency,compared_minor,status,opened_run_id,last_run_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'OPEN',$12,$12)`,[ctx.workspaceId,id,r.skuId,r.connectorId,r.scope,...values]);
    opened.push(id);
  }
  const present=new Map(evaluation.rows.map(r=>[key(r),r])),still=new Set(flagged.map(key)),watched=new Set(evaluation.connectors||[]);
  for(const a of open){
    const k=a.sku_id+'|'+a.connector_id+'|'+a.scope;if(still.has(k))continue;
    const r=present.get(k);let reason=null;
    if(r&&r.kind==='OK')reason=r.finding+'.';
    else if(!r&&evaluation.complete&&watched.has(a.connector_id))reason='No longer listed on this channel.';
    if(!reason)continue;// A missing or old channel price never clears a flag.
    await c.query(`UPDATE ${tables.alerts} SET status='CLEARED',cleared_reason=$3,cleared_at=clock_timestamp(),last_run_id=$4,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,a.id,reason,runId]);
    cleared.push(a.id);
  }
  const result={...summary,opened,updated,cleared};
  if(opened.length||cleared.length)await audit.record(c,ctx,{action:automatic?'StockChief checked channel prices':'Checked channel prices',
    reference:evaluation.rows.length+' channel prices',before:{open:open.map(a=>a.id)},after:{opened,cleared,flagged:summary.flagged.map(f=>f.label+': '+f.finding)}});
  await c.query(`UPDATE ${tables.runs} SET result=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,runId,JSON.stringify(result)]);
  return {runId,outcome,...result};
}

// Why StockChief only watches right now, or null.
async function automaticStop(db,workspaceId,state){
  const stop=await policy.stopped(db,workspaceId,state,ACTION,true);if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAct)return 'StockChief is watching only. Change its authority to get price flags.';
  return null;
}
async function hasChannelPrices(db,workspaceId){
  return (await db.query(`SELECT EXISTS(SELECT 1 FROM connection_mappings m JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id
      WHERE m.workspace_id=$1 AND m.entity_type='sku' AND c.status='connected')
    OR EXISTS(SELECT 1 FROM connection_commerce_positions WHERE workspace_id=$1 AND field='price' AND mode<>'off') AS listed`,[workspaceId])).rows[0].listed;
}
// Worker: check every recorded channel price on its own.
async function run(database,workspaceId){
  const actorId=await currentOwner(database,workspaceId);if(!actorId)return {skipped:'owner_unavailable'};
  const ctx={workspaceId,actorId},state=await policy.accountState(database,workspaceId);
  if(!alone(state))return {skipped:'plan'};
  const pilot=(await database.query('SELECT paused,suspended FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0];
  if(Number(pilot?.paused)||Number(pilot?.suspended))return {held:'paused'};
  return tx(database,async c=>record(c,ctx,await evaluate(c,workspaceId),{automatic:true,watch:await automaticStop(c,workspaceId,state)}));
}
async function schedule(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);if(!alone(state))return {queued:0};
  if(!(await hasChannelPrices(db,workspaceId)))return {queued:0};
  // Every hour, after the channels' own catalogue checks record their prices.
  const slot=Math.floor(Date.now()/3600000);
  const job=await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:KIND,priority:70,maxAttempts:3,idempotencyKey:'channel-prices:'+slot,payload:{}});
  return {queued:job.created?1:0};
}
// The owner checks now; with Ask me first, flags open on the owner's say.
async function checkNow(database,ctx){
  await owner(database,ctx);
  const state=await policy.requireWorkspaceJob(database,ctx.workspaceId,JOB,'draft');
  const stop=await policy.stopped(database,ctx.workspaceId,state,ACTION,false);if(stop)throw new ValidationError(stop);
  return tx(database,async c=>record(c,ctx,await evaluate(c,ctx.workspaceId),{automatic:false}));
}

// The review page: every recorded channel price and its finding, and the latest check.
async function review(db,ctx,{filter='',page=1}={}){
  await owner(db,ctx);
  const evaluation=await evaluate(db,ctx.workspaceId),text=String(filter||'').trim().toLowerCase();
  const state=await policy.accountState(db,ctx.workspaceId);
  const rows=evaluation.rows.filter(r=>!text||r.code.toLowerCase()===text||r.channel.toLowerCase()===text)
    .sort((a,b)=>(a.kind==='OK')-(b.kind==='OK')||a.code.localeCompare(b.code)||a.channel.localeCompare(b.channel)||a.where.localeCompare(b.where));
  const shownRows=rows.slice((page-1)*100,page*100).map(r=>({SKU:r.code,Channel:r.channel,Where:r.where,
    'Recorded provider price':r.recorded?shown(r.value?.amount,r.value?.currency):'Unavailable',
    'Catalogue price':r.catalogue?shown(r.catalogue.amount,r.catalogue.currency):'Not recorded',
    'Minimum advertised price':r.map?shown(r.map.amount,r.map.currency):'Not set',
    Checked:when(r.checkedAt),Finding:r.finding,link:'/settings/connections/'+r.connectorId}));
  const rules=(await db.query(`SELECT r.*,s.code FROM stockchief_runtime.channel_map_rules r JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id
    WHERE r.workspace_id=$1 ORDER BY s.code LIMIT 100`,[ctx.workspaceId])).rows;
  const latest=(await db.query(`SELECT outcome,reason,result,created_at FROM ${tables.runs} WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
  const automatic=alone(state)?await automaticStop(db,ctx.workspaceId,state):null;
  const last=latest?' Last automatic check '+new Date(latest.created_at).toISOString().slice(0,16).replace('T',' ')+' UTC'+(latest.outcome==='WATCHED'?', watching only: '+latest.reason:latest.outcome==='STOPPED'?', stopped: '+latest.reason:'')+'.':'';
  return {rows:shownRows,more:rows.length>page*100,
    mapForm:{rules:rules.map(r=>({...r,minimum:money.fromMinor(Number(r.minimum_minor),r.currency)}))},
    summary:(evaluation.problem?evaluation.problem+' ':'')+'Compares each channel’s recorded price with your catalogue price and your MAP terms. Without a catalogue price, channels are compared with each other. Prices older than 24 hours need a fresh check from the channel. StockChief checks every hour and flags differences in Needs you; changing a price always needs you.'+(automatic?' '+automatic:'')+last};
}

// Needs you: MAP breaks, price differences and prices that need a fresh check.
async function inbox(db,workspaceId){
  const installed=require('../db/schema-installed');
  if(!(await installed.has(db,tables.alerts))||!(await installed.has(db,tables.runs)))return [];
  const state=await policy.accountState(db,workspaceId);if(!alone(state))return [];
  const [counts,latest]=await Promise.all([db.query(`SELECT kind,count(*)::int n,min(label) first,max(updated_at) at FROM ${tables.alerts} WHERE workspace_id=$1 AND status='OPEN' GROUP BY kind`,[workspaceId]),
    db.query(`SELECT id,outcome,reason,result,created_at FROM ${tables.runs} WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,[workspaceId])]);
  const out=[];
  for(const r of counts.rows){
    const map=r.kind==='MAP_BREAK';
    out.push({kind:'sales',grouped:true,importance:map?'Urgent':'Important',priority:map?78:70,
      title:map?r.n+' channel price'+(r.n===1?' is':'s are')+' below your minimum advertised price':r.n+' channel price'+(r.n===1?' differs':'s differ')+' from your catalogue',
      happened:'First: '+r.first+'.',why:map?'Advertising below the supplier’s minimum price can break your supplier terms.':'The same item should sell at the same price on every channel.',
      recommendation:'Review the prices and change them where needed. StockChief does not change prices.',href:href,actionLabel:'Review channel prices',
      sourceId:map?'channel-price-map':'channel-price-mismatch',createdAt:r.at,at:r.at});
  }
  const run=latest.rows[0];
  if(run?.outcome==='STOPPED')out.push({kind:'sales',importance:'Needs You',priority:60,title:'The channel price check stopped',happened:String(run.reason||''),
    why:'StockChief does not skip prices.',recommendation:'Ask support to raise the limit.',href,actionLabel:'Review channel prices',sourceId:'channel-price-check:'+run.id,createdAt:run.created_at,at:run.created_at});
  else if(run?.outcome==='CHECKED'&&Number(run.result?.review)>0){
    const n=Number(run.result.review),first=run.result.reviewSample?.[0];
    out.push({kind:'sales',grouped:true,importance:'Needs You',priority:62,title:n+' channel price'+(n===1?' needs':'s need')+' a fresh check',
      happened:first?first.label+': '+first.finding+'.':'Some channel prices are old or missing.',why:'An old or missing price is never compared as if it were current.',
      recommendation:'Check the channel connection, or add the catalogue price.',href,actionLabel:'Review channel prices',sourceId:'channel-price-review:'+run.id,createdAt:run.created_at,at:run.created_at});
  }
  return out;
}

module.exports={JOB,ACTION,KIND,href,FINDINGS,observations,evaluate,record,run,schedule,checkNow,review,inbox};
