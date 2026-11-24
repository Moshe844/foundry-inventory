'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const rollout=require('../../src/connections/xero-customer-rollout');

test('customer posting requires exact provider grant evidence; pausing signup or writes preserves qualified reads',t=>{
 const before={...process.env};t.after(()=>{process.env={...before};});
 Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'production',XERO_CLIENT_ID:'approved-app',XERO_CLIENT_SECRET:'fixture',
  STOCKCHIEF_XERO_STARTER_CLIENT_ID:'approved-app',STOCKCHIEF_XERO_STARTER_CUSTOMERS_APPROVED:'1',
  STOCKCHIEF_XERO_GOVERNED_WRITES_APPROVED:'1',STOCKCHIEF_PRODUCTION_XERO_WORKSPACES:''});
 const box={provider_type:'xero',workspace_id:'customer',provider_account_id:'company',authorized_by_user_id:'owner',capabilities:['accounting:read']};
 const result={accountId:'company',verifiedFact:{externalId:'company'},capabilities:['accounting:read'],credentials:{tenantId:'company'}};
 box.config={xeroCustomerEvidence:rollout.evidence(box,'owner',result)};
 assert(rollout.certified(box));assert.doesNotThrow(()=>rollout.assertNoPosting(box,{configure:true}));
 assert.throws(()=>rollout.assertNoPosting(box),/Grant Xero posting permission/);
 const posting={...result,capabilities:['accounting:read','accounting:post']};
 for(const scope of [[],['accounting.invoices'],['accounting.manualjournals']]){
  const accessToken='fixture.'+Buffer.from(JSON.stringify({scope})).toString('base64url')+'.fixture';
  assert.throws(()=>rollout.evidence(box,'owner',{...posting,credentials:{tenantId:'company',accessToken}}),/posting permissions/);
 }
 const accessToken='fixture.'+Buffer.from(JSON.stringify({scope:['accounting.manualjournals','accounting.invoices']})).toString('base64url')+'.fixture';
 box.config={xeroCustomerEvidence:rollout.evidence(box,'owner',{...posting,credentials:{tenantId:'company',accessToken}})};
 box.capabilities=posting.capabilities;assert(rollout.postingCertified(box));assert.doesNotThrow(()=>rollout.assertNoPosting(box));
 for(const changed of [{workspace_id:'other'},{provider_account_id:'other'},{authorized_by_user_id:'other'},{provider_type:'quickbooks'}])
  assert.equal(rollout.certified({...box,...changed}),false);
 for(const changed of [{ownerPostingConsent:false},{postingScopesVerified:false},{clientId:'other'},{maxOrganizations:6}])
  assert.equal(rollout.certified({...box,config:{xeroCustomerEvidence:{...box.config.xeroCustomerEvidence,...changed}}}),false);
 assert.equal(rollout.postingCertified({...box,capabilities:['accounting:read']}),false);
 process.env.STOCKCHIEF_XERO_STARTER_CUSTOMERS_APPROVED='0';
 assert(rollout.writesEnabled());assert(rollout.certified(box));assert.doesNotThrow(()=>rollout.assertNoPosting(box));
 process.env.STOCKCHIEF_XERO_GOVERNED_WRITES_APPROVED='0';
 assert(rollout.certified(box));assert.throws(()=>rollout.assertNoPosting(box),/read-only/);
 process.env.XERO_CLIENT_ID='different-app';assert.equal(rollout.certified(box),false);assert.equal(rollout.writesEnabled(),false);
});
