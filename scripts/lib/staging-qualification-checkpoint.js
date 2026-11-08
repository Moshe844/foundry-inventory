'use strict';
function identity({jobId,release,run}){
 if(!/^[a-zA-Z0-9_-]{1,120}$/.test(jobId||'')||!/^[a-f0-9]{40}$/.test(release||'')||!/^[a-z0-9-]{6,60}$/.test(run||''))throw Error('An exact synthetic qualification identity is required.');
}
async function save(db,scope,state){
 identity(scope);const {jobId,release,run}=scope;
 if(state.run!==run||!/^wsp_[a-z0-9]+$/.test(state.ctx?.workspaceId||'')||!/^usr_[a-z0-9]+$/.test(state.ctx?.actorId||''))throw Error('A synthetic checkpoint needs its exact inventory and actor.');
 const saved={...state,workspaceId:state.ctx.workspaceId};
 const result=await db.query(`UPDATE stockchief_runtime.jobs j SET payload=jsonb_set(j.payload,'{qualificationCheckpoint}',$4::jsonb)
  WHERE j.id=$1 AND j.kind='qualification.staging-million' AND j.payload->>'release'=$2 AND j.payload->>'run'=$3 AND j.status='RUNNING'
  AND EXISTS(SELECT 1 FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id JOIN users u ON u.workspace_id=w.id AND u.id=$6 AND u.account_id=a.id AND u.role='owner'
   WHERE w.id=$5 AND w.name=$7 AND a.email=$8)`,[jobId,release,run,JSON.stringify(saved),state.ctx.workspaceId,state.ctx.actorId,'Synthetic ERP release million '+run,'stockchief-million-'+run+'@example.test']);
 if(result.rowCount!==1)throw Error('The qualification identity or running job changed before its checkpoint was saved.');
}
async function restore(db,scope){
 identity(scope);
 return (await db.query(`SELECT coalesce(payload->'qualificationCheckpoint',result->'evidence') AS evidence FROM stockchief_runtime.jobs
  WHERE kind='qualification.staging-million' AND payload->>'run'=$1 AND (status IN('COMPLETED','DEAD') OR id=$2 AND status='RUNNING')
  AND coalesce(payload->'qualificationCheckpoint',result->'evidence')->>'run'=$1
  AND coalesce(payload->'qualificationCheckpoint',result->'evidence')->'workspaceId' IS NOT NULL
  ORDER BY updated_at DESC,id DESC LIMIT 1`,[scope.run,scope.jobId])).rows[0]?.evidence;
}
module.exports={save,restore};
