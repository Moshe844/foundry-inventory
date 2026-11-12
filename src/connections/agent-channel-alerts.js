'use strict';

// Job 169: sales channel problems (oversell risk and a stopped sync), alone on
// every plan.
//
// The routine check (operational-notices.refresh, run by the worker's
// autopilot.evaluate) raises one alert per problem and clears it once fixed:
//  - a channel whose sync is paused, needs a new sign-in, is disconnected,
//    failed its last check, has gone quiet, or stopped sending new orders;
//  - a product whose last stock update to the channel failed or is stuck;
//  - a product the channel shows in a larger quantity than StockChief can sell
//    there: costed stock after customer orders, kit parts and protected stock,
//    transfer, rental and return holds, recalled or expired batches and the
//    channel's own stock buffer (postgres-commerce-sync.sellableMany, the same
//    figure StockChief publishes).
// The channel's figure is the newest one StockChief has: the last verified
// stock update or the last catalogue check, whichever is later. A channel
// figure StockChief has never seen is not guessed.
//
// Alerts change nothing, so they appear in the app and in Needs you in every
// mode. Email goes through agent-alerts.js, like jobs 166 to 168.

const JOB=169,key='channel-alerts',path='/autopilot/reviews/'+key;
const KINDS=Object.freeze({paused:'Sync paused',reconnect:'Reconnect needed',disconnected:'Channel disconnected',failed:'Sync failed',
  quiet:'No recent sync activity',events:'Order updates stopped',push:'Stock update failed',oversell:'Channel quantity exceeds available stock'});
const PROVIDERS=['shopify','woocommerce','square','clover','bigcommerce','amazon','ebay'];
const parse=v=>{if(v&&typeof v==='object')return v;try{return JSON.parse(v);}catch{return null;}};
const when=at=>{const t=at?Date.parse(at instanceof Date?at.toISOString():at):NaN;return Number.isFinite(t)?new Date(t).toISOString().slice(0,16).replace('T',' ')+' UTC':null;};

// Each sales channel and what, if anything, stopped its sync.
const channelsSql=`WITH channels AS (
  SELECT c.*,coalesce((v.configuration->>'syncIntervalSeconds')::integer,60) AS minimum_seconds
  FROM workspace_connectors c JOIN workspaces w ON w.id=c.workspace_id
  LEFT JOIN account_subscriptions sub ON sub.account_id=w.owner_account_id LEFT JOIN commercial_plan_versions v ON v.id=sub.plan_version_id AND v.plan_id=sub.plan_id
  WHERE c.workspace_id=$1 AND (c.provider_type=ANY($2::text[])
    OR EXISTS(SELECT 1 FROM connection_commerce_positions p WHERE p.workspace_id=c.workspace_id AND p.connector_id=c.id))
)
SELECT c.id,c.display_name,c.last_error,greatest(c.last_synced_at::timestamptz,c.last_activity_at::timestamptz,c.created_at::timestamptz) AS last_evidence,
  CASE WHEN c.paused_at IS NOT NULL OR c.config::jsonb->>'syncDisabled'='true' THEN 'paused'
    WHEN c.setup_status='REAUTHORIZATION_REQUIRED' THEN 'reconnect'
    WHEN c.status='disconnected' AND c.provider_account_id IS NOT NULL AND c.setup_status IS DISTINCT FROM 'DUPLICATE_CONNECTION' THEN 'disconnected'
    WHEN c.status='error' OR (nullif(c.last_error,'') IS NOT NULL AND events.id IS NULL) THEN 'failed'
    WHEN c.status='connected' AND greatest(c.last_synced_at::timestamptz,c.last_activity_at::timestamptz,c.created_at::timestamptz)
      +greatest(c.expected_interval_minutes*60,c.minimum_seconds,60)*interval '2 seconds'<now() THEN 'quiet' END AS problem,
  events.id AS events_id,events.detail AS events_detail
FROM channels c LEFT JOIN LATERAL (SELECT i.id,i.detail FROM connection_issues i WHERE i.workspace_id=c.workspace_id AND i.connector_id=c.id
  AND i.issue_type='PUSH_SETUP_FAILED' AND i.status='OPEN' ORDER BY i.updated_at DESC LIMIT 1) events ON c.status='connected'
ORDER BY c.display_name,c.id`;

// Every product a channel keeps stock for, with the newest channel figure.
const positionsSql=`SELECT p.id,p.connector_id,c.display_name,s.code,l.name AS location,p.external_location_id,
  p.baseline_provider,p.last_verified_at,r.provider_data,r.last_seen_at,e.status AS effect_status,e.error_message AS effect_error,e.updated_at AS effect_at
 FROM connection_commerce_positions p JOIN workspace_connectors c ON c.workspace_id=p.workspace_id AND c.id=p.connector_id
 JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id
 LEFT JOIN connection_external_records r ON r.workspace_id=p.workspace_id AND r.connector_id=p.connector_id AND r.entity_type='sku' AND r.external_id=p.external_id AND r.selected=1
 LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=p.workspace_id AND e.id=p.pending_effect_id
 WHERE p.workspace_id=$1 AND p.field='quantity' AND p.mode<>'off'
 ORDER BY c.display_name,s.code,l.name,p.id`;

// The newest whole-unit figure the channel showed, and when.
function shown(p){
  const seen=[];
  const baseline=parse(p.baseline_provider);
  if(Number.isSafeInteger(baseline)&&baseline>=0&&p.last_verified_at)seen.push({value:baseline,at:new Date(p.last_verified_at).getTime()});
  const data=parse(p.provider_data)||{},count=(data.syncCounts||data.inventoryCounts||[]).find?.(q=>q.externalLocationId===p.external_location_id);
  const listed=count?.quantity==null?null:Number(count.quantity);
  if(Number.isSafeInteger(listed)&&listed>=0&&p.last_seen_at)seen.push({value:listed,at:Date.parse(p.last_seen_at)});
  return seen.filter(s=>Number.isFinite(s.at)).sort((a,b)=>b.at-a.at)[0]||null;
}

// Every current problem. Rows carry the notice key (kind, ref, link) and what the pages and emails show.
async function evaluate(db,workspaceId){
  const rows=[];
  for(const c of (await db.query(channelsSql,[workspaceId,PROVIDERS])).rows){
    const base={channel:c.display_name,connectorId:c.id,ref:c.id,link:'/settings/connections/'+c.id,sku:null,location:null,shows:null,sellable:null};
    if(c.problem){
      const detail={paused:'Sync is paused, so stock and orders stop updating.',reconnect:'The channel refused StockChief’s sign-in. Reconnect it to restore updates.',
        disconnected:'The channel is disconnected, so stock and orders stop updating.',failed:c.last_error||'The last check of the channel did not finish.',
        quiet:'Nothing has arrived from the channel since '+(when(c.last_evidence)||'it was connected')+'.'}[c.problem];
      rows.push({...base,kind:KINDS[c.problem],detail,at:c.last_evidence});
    }
    if(c.events_id)rows.push({...base,kind:KINDS.events,detail:c.events_detail||'The channel is not sending new orders to StockChief.',at:null});
  }
  const positions=(await db.query(positionsSql,[workspaceId])).rows;
  const sellable=await require('./postgres-commerce-sync').sellableMany(db,workspaceId,positions.map(p=>p.id));
  for(const p of positions){
    const base={channel:p.display_name,connectorId:p.connector_id,ref:p.id,link:'/settings/connections/'+p.connector_id,sku:p.code,location:p.location};
    const can=sellable.get(p.id),seen=shown(p);
    const stuck=p.effect_status==='PENDING'&&Date.now()-new Date(p.effect_at).getTime()>3600000;
    if(['FAILED','AMBIGUOUS'].includes(p.effect_status)||stuck)rows.push({...base,kind:KINDS.push,shows:seen?.value??null,sellable:can?.value??null,at:p.effect_at,
      detail:p.effect_status==='AMBIGUOUS'?'The channel did not confirm the last stock update. StockChief checks it before sending another.':
        stuck?'The last stock update has waited more than an hour to reach the channel.':(p.effect_error||'The last stock update did not reach the channel.')});
    if(can&&seen&&seen.value>can.value)rows.push({...base,kind:KINDS.oversell,shows:seen.value,sellable:can.value,at:new Date(seen.at).toISOString(),
      detail:'The channel shows '+seen.value+' but you can sell '+can.value+' after orders, holds'+(can.buffer?' and your '+can.buffer+'-unit buffer':'')+'.'});
  }
  return rows;
}

// The notices the routine check keeps open.
async function candidates(db,workspaceId){return (await evaluate(db,workspaceId)).map(r=>({kind:r.kind,ref:r.ref,link:r.link}));}

function describe(r){
  const none='—';
  return {Channel:r.channel,Alert:r.kind,SKU:r.sku??'All products',Location:r.location??'All locations','Channel shows':r.shows??none,'You can sell':r.sellable??none,
    Details:r.detail,Seen:when(r.at)||none,link:r.link};
}
async function review(db,ctx,{filter='',page=1}={}){
  const text=String(filter||'').trim().toLowerCase();
  const rows=(await evaluate(db,ctx.workspaceId)).filter(r=>!text||r.channel.toLowerCase()===text||String(r.sku||'').toLowerCase()===text)
    .sort((a,b)=>(b.kind===KINDS.oversell)-(a.kind===KINDS.oversell)||a.channel.localeCompare(b.channel)||String(a.sku||'').localeCompare(String(b.sku||'')));
  return {rows:rows.slice((page-1)*100,page*100).map(describe),more:rows.length>page*100,
    summary:'Channels that show more stock than you can sell, and channels whose sync stopped or failed. You can sell what is left after customer orders, '+
      'protected stock, transfer, rental and return holds, and your channel buffers. StockChief checks through the day and clears an alert once it is fixed.'};
}

// One plain line per alert, for the alert email.
async function lines(db,workspaceId,keys){
  const found=new Map((await evaluate(db,workspaceId)).map(r=>[r.kind+'\u0000'+r.ref+'\u0000'+r.link,r]));
  return keys.map(k=>{
    const r=found.get(k.kind+'\u0000'+k.reference+'\u0000'+k.link);
    if(!r)return k.kind+'.';
    return r.channel+(r.sku?': '+r.sku+(r.location?' at '+r.location:''):'')+' ('+r.kind+'). '+r.detail;
  });
}

const definition={id:JOB,key,label:'Sales channel problems',filterLabel:'Channel or SKU',readPage:review};
module.exports={JOB,KINDS,key,path,evaluate,candidates,lines,definition};
