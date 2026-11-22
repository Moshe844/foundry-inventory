'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const pilot=require('../../src/connections/accounting-review-pilot'),policy=require('../../src/connections/launch-policy');
test('accounting qualification is exact inventory and provider scoped, fail closed, and production-only',async t=>{
 const before={...process.env};t.after(()=>{process.env={...before};});
 Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'production',STOCKCHIEF_PRODUCTION_XERO_WORKSPACES:'approved',
  STOCKCHIEF_PRODUCTION_QUICKBOOKS_WORKSPACES:'qb-approved',QUICKBOOKS_ENVIRONMENT:'sandbox',XERO_CLIENT_ID:'private-xero-app'});
 assert.equal(policy.reason('xero',{workspaceId:'approved'}),null);
 assert.equal(policy.metadata({type:'xero',available:false},{workspaceId:'approved'}).available,false,'Availability still requires real configuration');
 assert.throws(()=>policy.assertNewConnection('xero',{workspaceId:'other'}));
 assert.throws(()=>policy.assertNewConnection('xero'));
 assert.throws(()=>policy.assertNewConnection('quickbooks',{workspaceId:'qb-approved'}),'Sandbox keys cannot enable production QuickBooks');
 assert.doesNotThrow(()=>policy.assertCallbackProvider('xero'));
 assert.throws(()=>policy.assertCallbackProvider('quickbooks'));
 process.env.QUICKBOOKS_ENVIRONMENT='production';
 assert.equal(policy.reason('quickbooks',{workspaceId:'qb-approved'}),null);
 assert.throws(()=>policy.assertNewConnection('quickbooks',{workspaceId:'approved'}));
 await assert.rejects(policy.assertWorkspaceConnection({query:async()=>({rows:[]})},'xero',{workspaceId:'approved'}),/no longer available/);
 process.env.STOCKCHIEF_PRODUCTION_XERO_WORKSPACES='approved,invalid/workspace';
 assert.throws(()=>policy.assertNewConnection('xero',{workspaceId:'approved'}));
 process.env.STOCKCHIEF_PRODUCTION_XERO_WORKSPACES='approved';
 process.env.STOCKCHIEF_RUNTIME_ENV='development';assert.equal(pilot.allowed('xero','approved'),false);
});
test('private accounting evidence binds provider confirmation, actual grant, app, actor and inventory',t=>{
 const before={...process.env};t.after(()=>{process.env={...before};});
 Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'production',STOCKCHIEF_PRODUCTION_XERO_WORKSPACES:'approved',XERO_CLIENT_ID:'private-xero-app'});
 const connection={provider_type:'xero',workspace_id:'approved'},result={accountId:'org-1',credentials:{tenantId:'org-1'},verifiedFact:{externalId:'org-1'}};
 const evidence=pilot.evidence(connection,'owner-1',result);
 assert.deepEqual(evidence,{source:pilot.SOURCE,provider:'xero',workspaceId:'approved',providerAccountId:'org-1',clientId:'private-xero-app',approvedByUserId:'owner-1',qualificationOnly:true});
 for(const bad of [{...result,credentials:{tenantId:'other'}},{...result,verifiedFact:{externalId:'other'}},{...result,accountId:''}])
  assert.throws(()=>pilot.evidence(connection,'owner-1',bad));
 assert.throws(()=>pilot.evidence({...connection,workspace_id:'other'},'owner-1',result));
 assert.throws(()=>pilot.evidence(connection,null,result));
 delete process.env.STOCKCHIEF_PRODUCTION_XERO_WORKSPACES;assert.throws(()=>pilot.evidence(connection,'owner-1',result));
});
