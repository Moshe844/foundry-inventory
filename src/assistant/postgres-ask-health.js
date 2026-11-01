'use strict';
function state(pilot,now=Date.now()){
 const available=Boolean(pilot?.worker_seen_at&&now-new Date(pilot.worker_seen_at).getTime()<30000);
 const funded=Boolean(pilot?.enabled&&!pilot.stopped&&pilot.approval_reference&&Number(pilot.ceiling_micro_usd)>0&&new Date(pilot.period_ends_at).getTime()>now);
 return {ok:available&&funded,workerAvailable:available,allowanceAvailable:funded,message:!funded?'Ask is paused because its usage allowance is unavailable. No AI credits will be used while it is paused.':!available?'Ask is temporarily offline. Saved requests are waiting for an agent. You can keep using inventory, orders and reports.':'Ask is ready.'};
}
async function sweep(db,{now=Date.now()}={}){
 const pilots=(await db.query('SELECT workspace_id,enabled,stopped,approval_reference,ceiling_micro_usd,period_ends_at,worker_seen_at FROM stockchief_runtime.codex_pilots WHERE enabled=TRUE')).rows;let unavailable=0;
 for(const pilot of pilots){const health=state(pilot,now),fingerprint='ask-worker:'+pilot.workspace_id;
  if(health.allowanceAvailable&&!health.workerAvailable){unavailable++;await require('../operations/postgres-monitoring').raise(db,{workspaceId:pilot.workspace_id,kind:'ask.worker_unavailable',severity:'ERROR',fingerprint,title:'Ask has no available agent',detail:'No agent heartbeat has arrived in 30 seconds. Check the configured worker, provider credentials and sandbox startup. Saved requests remain queued; no budget is extended by this alert.'});}
  else await db.query("UPDATE operational_alerts SET status='RESOLVED',resolved_at=$3 WHERE workspace_id=$1 AND fingerprint=$2 AND status IN ('OPEN','DELIVERED','ACKNOWLEDGED')",[pilot.workspace_id,fingerprint,new Date(now).toISOString()]);
 }
 return {checked:pilots.length,unavailable};
}
async function read(db,ctx){
 const {pilot}=await require('./postgres-codex-pilot').access(db,ctx);
 if(pilot.unprovisioned){const heartbeat=(await db.query("SELECT max(worker_seen_at) AS worker_seen_at FROM stockchief_runtime.codex_pilots WHERE admission_kind='COMMERCIAL'")).rows[0];return state({...pilot,worker_seen_at:heartbeat?.worker_seen_at});}
 return state(pilot);
}
module.exports={state,sweep,read};
