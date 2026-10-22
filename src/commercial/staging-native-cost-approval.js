'use strict';
// Deployment-owned, expiring exceptions for a specifically approved test
// account/funding inventory. Never an entitlement or an ordinary customer cap.
function approved({accountId,fundingWorkspaceId,nativeTransport,goalRuntime,fundingActive,now=Date.now()}){
 const raw=process.env.STOCKCHIEF_STAGING_NATIVE_COST_APPROVALS;
 if(!raw||!nativeTransport||goalRuntime!=='codex-staging')return null;
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='staging')throw Error('STAGING_NATIVE_COST_APPROVAL_ONLY');
 const approvals=JSON.parse(raw);if(!Array.isArray(approvals))throw Error('INVALID_STAGING_NATIVE_COST_APPROVAL');
 for(const a of approvals)if(typeof a.accountId!=='string'||!a.accountId||typeof a.fundingWorkspaceId!=='string'||!a.fundingWorkspaceId||
  !Number.isSafeInteger(a.maximumMinor)||a.maximumMinor<1||!Number.isFinite(Date.parse(a.expiresAt))||typeof a.approvalReference!=='string'||!a.approvalReference.trim())throw Error('INVALID_STAGING_NATIVE_COST_APPROVAL');
 if(!fundingActive)return null;
 const matches=approvals.filter(a=>a.accountId===accountId&&a.fundingWorkspaceId===fundingWorkspaceId&&Date.parse(a.expiresAt)>now);
 return matches.sort((a,b)=>b.maximumMinor-a.maximumMinor)[0]||null;
}
module.exports={approved};
