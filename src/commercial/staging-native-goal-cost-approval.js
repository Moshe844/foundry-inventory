'use strict';
// Exact, expiring deployment approvals for existing native certification goals.
// New goals retain their database budget and ordinary customers retain their limits.
function approved({accountId,workspaceId,actorId,goalId,runtime,nativeTransport,fundingActive,now=Date.now()}){
 const raw=process.env.STOCKCHIEF_STAGING_NATIVE_GOAL_COST_APPROVALS;
 if(!raw||!nativeTransport||runtime!=='codex-staging')return null;
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='staging')throw Error('STAGING_NATIVE_GOAL_APPROVAL_ONLY');
 const rows=JSON.parse(raw);if(!Array.isArray(rows))throw Error('INVALID_STAGING_NATIVE_GOAL_APPROVAL');
 for(const a of rows)if(['accountId','workspaceId','actorId','goalId','approvalReference'].some(k=>typeof a[k]!=='string'||!a[k].trim())||!Number.isSafeInteger(a.maximumMinor)||a.maximumMinor<1||!Number.isFinite(Date.parse(a.expiresAt)))throw Error('INVALID_STAGING_NATIVE_GOAL_APPROVAL');
 if(!fundingActive)return null;
 return rows.filter(a=>a.accountId===accountId&&a.workspaceId===workspaceId&&a.actorId===actorId&&a.goalId===goalId&&Date.parse(a.expiresAt)>now).sort((a,b)=>b.maximumMinor-a.maximumMinor)[0]||null;
}
async function effective(database,scope,goal,{nativeTransport=false,now=Date.now()}={}){
 const base={maximumMinor:Number(goal.budgetMinor),approval:null};
 if(!process.env.STOCKCHIEF_STAGING_NATIVE_GOAL_COST_APPROVALS||!nativeTransport||goal.runtime!=='codex-staging')return base;
 const context={accountId:scope.accountId,workspaceId:scope.workspaceId,actorId:goal.actorId,goalId:goal.id,runtime:goal.runtime,nativeTransport,now};
 if(!approved({...context,fundingActive:true}))return base;
 const funding=(await database.query('SELECT pilot FROM stockchief_runtime.codex_pilot_workspace_access WHERE workspace_id=$1 AND owner_account_id=$2',[scope.workspaceId,scope.accountId])).rows[0]?.pilot;
 const approval=approved({...context,fundingActive:!!(funding?.admission_kind==='PILOT'&&funding.enabled&&!funding.stopped&&Date.parse(funding.period_ends_at)>now)});
 return approval?{maximumMinor:Math.max(base.maximumMinor,approval.maximumMinor),approval}:base;
}
module.exports={approved,effective};
