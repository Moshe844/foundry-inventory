'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const lifecycle=require('../../src/connections/quickbooks-token-lifecycle');

test('QuickBooks grant locks isolate applications and companies and reuse only the live held session',async()=>{
 assert.notEqual(lifecycle.key('app','company'),lifecycle.key('other-app','company'));
 assert.notEqual(lifecycle.key('app','company'),lifecycle.key('app','other-company'));
 assert.doesNotMatch(lifecycle.key('app','PRIVATE_COMPANY'),/PRIVATE_COMPANY/);
 const session={},db={withSessionLock:async(_key,run)=>{locks++;return run(session);}};let locks=0;
 await lifecycle.run(db,'app','company',async current=>{
  assert.equal(current,session);
  await lifecycle.run(current,'app','company',async nested=>assert.equal(nested,session));
 });
 assert.equal(locks,1);await lifecycle.run(db,'app','company',async()=>{});assert.equal(locks,2);
});

test('busy or unavailable QuickBooks grant sessions do not execute provider operations',async()=>{
 let calls=0;
 await assert.rejects(lifecycle.run({},'app','company',async()=>{calls++;}),error=>error.code==='QUICKBOOKS_SESSION_LOCK_UNAVAILABLE'&&error.transient);
 await assert.rejects(lifecycle.run({withSessionLock:async()=>({busy:true})},'app','company',async()=>{calls++;}),error=>error.code==='QUICKBOOKS_AUTHORIZATION_BUSY'&&error.transient);
 assert.equal(calls,0);
});

test('QuickBooks revocation uses the discovery endpoint and current refresh token without retrying failed POSTs',async t=>{
 const before={id:process.env.QUICKBOOKS_CLIENT_ID,secret:process.env.QUICKBOOKS_CLIENT_SECRET};
 process.env.QUICKBOOKS_CLIENT_ID='revocation-fixture';process.env.QUICKBOOKS_CLIENT_SECRET='revocation-fixture-secret';
 t.after(()=>{for(const [key,value]of [['QUICKBOOKS_CLIENT_ID',before.id],['QUICKBOOKS_CLIENT_SECRET',before.secret]])if(value===undefined)delete process.env[key];else process.env[key]=value;});
 let calls=0,status=200,body={};
 t.mock.method(global,'fetch',async(value,options)=>{
  calls++;assert.equal(String(value),'https://developer.api.intuit.com/v2/oauth2/tokens/revoke');assert.equal(options.method,'POST');
  assert.equal(options.headers.authorization,'Basic '+Buffer.from('revocation-fixture:revocation-fixture-secret').toString('base64'));
  assert.deepEqual(JSON.parse(options.body),{token:'current-refresh'});return Response.json(body,{status});
 });
 const qbo=require('../../src/connections/providers/quickbooks'),grant={accessToken:'access',refreshToken:'current-refresh'};
 assert.equal(await qbo.revokeAuthorization(grant),true);
 body={error:'invalid_token'};assert.equal(await qbo.revokeAuthorization(grant),false);
 status=503;const count=calls;await assert.rejects(qbo.revokeAuthorization(grant));assert.equal(calls,count+1);
});
