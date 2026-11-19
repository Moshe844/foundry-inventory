'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const originalEnv={...process.env},originalFetch=global.fetch;
const appId='A123456789012',merchant='M123456789012',other='N123456789012';
const pilot=require('../../src/connections/clover-review-pilot');
const policy=require('../../src/connections/launch-policy');
const clover=require('../../src/connections/providers/clover');
test.beforeEach(()=>Object.assign(process.env,{NODE_ENV:'test',STOCKCHIEF_RUNTIME_ENV:'production',CLOVER_ENVIRONMENT:'production',
 CLOVER_CLIENT_ID:appId,CLOVER_CLIENT_SECRET:'isolated-secret',CLOVER_WEBHOOK_AUTH_CODE:'isolated-webhook',
 STOCKCHIEF_PRODUCTION_CLOVER_PILOTS:JSON.stringify({approved:[merchant]})}));
test.afterEach(()=>{process.env={...originalEnv};global.fetch=originalFetch;});
test('Clover private test admits only exact configured inventories and merchants',async()=>{
 assert.equal(pilot.expected('approved'),merchant);
 assert.equal(policy.metadata({type:'clover',available:true},{workspaceId:'approved'}).available,true);
 assert.equal(policy.metadata({type:'clover',available:true},{workspaceId:'outside'}).available,false);
 assert.throws(()=>policy.assertNewConnection('quickbooks',{workspaceId:'approved'}));
 assert.throws(()=>pilot.expected('approved',{merchantId:other}),/assigned/);
 assert.throws(()=>pilot.expected('outside',{merchantId:merchant}));
 assert.doesNotThrow(()=>policy.assertCallbackProvider('clover'));
 const db={query:async()=>({rows:[{id:'approved'}]})};
 await policy.assertWorkspaceConnection(db,'clover',{workspaceId:'approved'},{merchantId:merchant});
 await assert.rejects(policy.assertWorkspaceConnection(db,'clover',{workspaceId:'approved'},{merchantId:other}));
 process.env.STOCKCHIEF_PRODUCTION_CLOVER_PILOTS='{}';assert.throws(()=>policy.assertCallbackProvider('clover'));
});
test('malformed, cross-inventory duplicate and non-production permits fail closed',()=>{
 for(const invalid of ['[]','null','{bad',JSON.stringify({approved:['not-an-id']}),JSON.stringify({approved:[merchant],outside:[merchant]})]){
  process.env.STOCKCHIEF_PRODUCTION_CLOVER_PILOTS=invalid;assert.deepEqual(pilot.pilots(),{});
 }
 process.env.STOCKCHIEF_PRODUCTION_CLOVER_PILOTS=JSON.stringify({approved:[merchant]});
 process.env.CLOVER_ENVIRONMENT='sandbox';assert.deepEqual(pilot.pilots(),{});
});
function metadata(){return clover.authorizationUrl({state:'isolated-state',input:{redirectUri:'https://app.example.test/settings/connections/clover/callback',cloverTestMerchantId:merchant}}).metadata;}
function grant(){return {access_token:'isolated-access',refresh_token:'isolated-refresh',access_token_expiration:Math.floor(Date.now()/1000)+1800,refresh_token_expiration:Math.floor(Date.now()/1000)+86400};}
test('wrong merchant and changed app fail before exchanging a code',async()=>{
 let calls=0;global.fetch=async()=>{calls++;throw Error('Must not contact provider');};
 await assert.rejects(clover.exchangeAuthorization({query:{code:'code',merchant_id:other},metadata:metadata()}),/different merchant/);
 const saved=metadata();process.env.CLOVER_CLIENT_ID='B123456789012';
 await assert.rejects(clover.exchangeAuthorization({query:{code:'code',merchant_id:merchant},metadata:saved}),/application changed/);
 assert.equal(calls,0);
});
test('only a provider-confirmed matching non-billable merchant can complete the private test',async()=>{
 for(const supplied of [{id:merchant,isBillable:true},{id:merchant},{id:other,isBillable:false},{id:merchant,isBillable:'false'}]){
  global.fetch=async url=>new URL(url).pathname.endsWith('/token')?Response.json(grant()):Response.json(supplied);
  await assert.rejects(clover.exchangeAuthorization({query:{code:'code',merchant_id:merchant},metadata:metadata()}),/non-billable/);
 }
 global.fetch=async url=>new URL(url).pathname.endsWith('/token')?Response.json(grant()):Response.json({id:merchant,isBillable:false,name:'Isolated test merchant'});
 const result=await clover.exchangeAuthorization({query:{code:'code',merchant_id:merchant},metadata:metadata()});
 assert.equal(result.accountId,merchant);assert.equal(result.credentials.isBillable,false);assert.equal(result.credentials.clientId,appId);
});
test('a saved Clover grant is not refreshed through another application',async()=>{
 let calls=0;global.fetch=async()=>{calls++;throw Error('Must not contact provider');};
 await assert.rejects(clover.refreshCredentials({clientId:'B123456789012'}),/different application/);assert.equal(calls,0);
});
