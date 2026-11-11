'use strict';
function state(pilot,now=Date.now()){
 const available=[pilot?.worker_seen_at,pilot?.hosted_seen_at].some(at=>at&&now-new Date(at).getTime()<30000);
 const lock=require('./postgres-codex-pilot').spendingLockMessage(pilot,now),funded=!lock;
 return {ok:available&&funded,workerAvailable:available,allowanceAvailable:funded,message:lock?'Model-backed Ask requests are paused. '+lock+' Stock lookups and page navigation are available.':!available?'Ask is temporarily offline. Saved requests are waiting for an agent. You can keep using inventory, orders and reports.':'Ask is ready.'};
}
async function sweep(db,{now=Date.now()}={}){
 const pilots=(await db.query(`SELECT p.workspace_id,p.enabled,p.stopped,p.approval_reference,p.ceiling_micro_usd,p.period_ends_at,p.worker_seen_at,h.hosted_seen_at
 FROM stockchief_runtime.codex_pilots p CROSS JOIN (SELECT max(last_seen_at) AS hosted_seen_at FROM stockchief_runtime.assistant_worker_health WHERE kind='database-read') h WHERE p.enabled=TRUE`)).rows;let unavailable=0;
 for(const pilot of pilots){const health=state(pilot,now),fingerprint='ask-worker:'+pilot.workspace_id;
  if(health.allowanceAvailable&&!health.workerAvailable){unavailable++;await require('../operations/postgres-monitoring').raise(db,{workspaceId:pilot.workspace_id,kind:'ask.worker_unavailable',severity:'ERROR',fingerprint,title:'Ask has no available agent',detail:'No agent heartbeat has arrived in 30 seconds. Check the configured worker, provider credentials and sandbox startup. Saved requests remain queued; no budget is extended by this alert.'});}
  else await db.query("UPDATE operational_alerts SET status='RESOLVED',resolved_at=$3 WHERE workspace_id=$1 AND fingerprint=$2 AND status IN ('OPEN','DELIVERED','ACKNOWLEDGED')",[pilot.workspace_id,fingerprint,new Date(now).toISOString()]);
 }
 return {checked:pilots.length,unavailable};
}
async function read(db,ctx){
 const {pilot,commercialAccess}=await require('./postgres-codex-pilot').access(db,ctx);
 const hosted=(await db.query("SELECT max(last_seen_at) AS hosted_seen_at FROM stockchief_runtime.assistant_worker_health WHERE kind='database-read'")).rows[0];
 const health={...pilot,...hosted};
 if(pilot.admission_kind!=='COMMERCIAL'||!commercialAccess.period)return state(health);
 if(pilot.unprovisioned){
  const heartbeat=(await db.query("SELECT max(worker_seen_at) AS worker_seen_at FROM stockchief_runtime.codex_pilots WHERE admission_kind='COMMERCIAL'")).rows[0];
  health.worker_seen_at=heartbeat?.worker_seen_at;
 }
 // The paid subscription establishes the current credit period. The stored
 // execution record is renewed on submission and can still show the prior month.
 const periodEnd=commercialAccess.period.end.toISOString();
 const readiness=state({...health,period_ends_at:periodEnd,ceiling_micro_usd:commercialAccess.ceiling});
 if(!readiness.allowanceAvailable)return readiness;
 const credits=await require('../commercial/entitlements').meterState(db,commercialAccess.scope,'ai_work_credits',
  {subscription:commercialAccess.subscription});
 if(credits.remaining!==null&&credits.remaining<=0)return {...readiness,ok:false,allowanceAvailable:false,
  reason:'credits_exhausted',periodEnd,message:'AI credits are used up. See your renewal date and available credit add-ons in Plan & billing.'};
 return {...readiness,periodEnd};
}
module.exports={state,sweep,read};
