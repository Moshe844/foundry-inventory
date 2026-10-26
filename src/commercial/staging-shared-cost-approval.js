'use strict';
function approved(scope,{fundingWorkspaceId,fundingActive,now=Date.now()}={}){
 const raw=process.env.STOCKCHIEF_STAGING_SHARED_COST_APPROVALS;if(!raw)return null;
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='staging')throw Error('STAGING_SHARED_COST_APPROVAL_ONLY');
 const approvals=JSON.parse(raw);if(!Array.isArray(approvals))throw Error('INVALID_SHARED_COST_APPROVAL');
 for(const a of approvals)if(!a.accountId||!a.fundingWorkspaceId||!Number.isSafeInteger(a.maximumMinor)||a.maximumMinor<1||!Number.isFinite(Date.parse(a.expiresAt))||!a.approvalReference)throw Error('INVALID_SHARED_COST_APPROVAL');
 if(!fundingActive)return null;return approvals.filter(a=>a.accountId===scope.accountId&&a.fundingWorkspaceId===fundingWorkspaceId&&Date.parse(a.expiresAt)>now).sort((a,b)=>b.maximumMinor-a.maximumMinor)[0]||null;
}
async function resolve(db,scope,{requireActor=false}={}){
 if(!process.env.STOCKCHIEF_STAGING_SHARED_COST_APPROVALS)return null;
 const funding=(await db.query('SELECT funding_workspace_id,pilot FROM stockchief_runtime.codex_pilot_workspace_access WHERE workspace_id=$1 AND owner_account_id=$2',[scope.workspaceId,scope.accountId])).rows[0];
 if(requireActor){const actor=(await db.query('SELECT account_id,role FROM users WHERE workspace_id=$1 AND id=$2',[scope.workspaceId,scope.actorId||null])).rows[0];if(!actor||actor.account_id!==scope.accountId||!(funding?.pilot?.account_inherited?actor.role==='owner':funding?.pilot?.authorized_actor_ids?.includes(scope.actorId)))return null;}
 return approved(scope,{fundingWorkspaceId:funding?.funding_workspace_id,fundingActive:Boolean(funding?.pilot?.enabled&&!funding.pilot.stopped&&Date.parse(funding.pilot.period_ends_at)>Date.now())});
}
module.exports={approved,resolve};
