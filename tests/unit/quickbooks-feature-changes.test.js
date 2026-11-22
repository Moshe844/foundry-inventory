'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const qbo=require('../../src/connections/providers/quickbooks');
const failures=require('../../src/connections/provider-sync-failure');
const credentials=Object.freeze({realmId:'qualification-company',accessToken:'fixture-access',refreshToken:'fixture-refresh'});

test('inventory feature loss and restoration recheck preferences without changing the grant or emitting stale quantities',async t=>{
 let tracking=true,itemCalls=0;
 t.mock.method(global,'fetch',async(value,options)=>{
  const url=new URL(value);assert.equal(options.method||'GET','GET');
  assert.match(url.hostname,/^(sandbox-)?quickbooks\.api\.intuit\.com$/);
  if(url.pathname.includes('/companyinfo/'))return Response.json({CompanyInfo:{CompanyName:'Qualification company'}});
  if(url.pathname.endsWith('/preferences'))return Response.json({Preferences:{ProductAndServicesPrefs:{QuantityOnHand:tracking},CurrencyPrefs:{HomeCurrency:{value:'USD'}}}});
  itemCalls++;return Response.json({QueryResponse:{Item:[{Id:'stock',Name:'Stock',Type:'Inventory',TrackQtyOnHand:true,QtyOnHand:12,UnitPrice:25}]}});
 });
 const before={...credentials},initial=await qbo.discover({credentials});
 assert.equal(initial.products[0].providerData.inventoryCounts[0].quantity,12);
 for(const unavailable of [false,undefined,null,0,'true']){
  tracking=unavailable;const emitted=[],calls=itemCalls;
  await assert.rejects(qbo.discover({credentials,onProduct:r=>emitted.push(r)}),error=>{
   assert.equal(error.code,'QUICKBOOKS_INVENTORY_UNAVAILABLE');assert.equal(failures.accessRejected(error),false);
   assert.match(failures.explanation({syncFailureCode:error.code}),/plan and inventory settings/);return true;
  });
  assert.equal(itemCalls,calls);assert.deepEqual(emitted,[]);assert.deepEqual(credentials,before);
 }
 tracking=true;const restored=await qbo.discover({credentials});
 assert.deepEqual(restored,initial);assert.deepEqual(credentials,before);
});

test('feature restrictions in successful or failed HTTP responses remain recoverable without reauthorization',async t=>{
 let status=200,restricted=true,calls=0;
 t.mock.method(global,'fetch',async()=>{
  calls++;
  return restricted?Response.json({Fault:{type:'ValidationFault',Error:[{code:'5030',Message:'Feature Not Supported'}]}},{status}):
   Response.json({CompanyInfo:{Id:'1',CompanyName:'Qualification company'}});
 });
 for(const code of [200,400,403]){
  status=code;const before=calls;
  await assert.rejects(qbo.verifyReadOnly({credentials}),error=>{
   assert.equal(error.code,'QUICKBOOKS_FEATURE_UNAVAILABLE');assert.equal(failures.accessRejected(error),false);return true;
  });
  assert.equal(calls,before+1,'Feature denial must not trigger a retry loop');
 }
 restricted=false;
 assert.equal((await qbo.verifyReadOnly({credentials})).externalId,credentials.realmId);
});

test('HTTP 200 faults cannot be mistaken for empty entity lists or confirmed journal writes',async t=>{
 let authentication=false,calls=0;
 t.mock.method(global,'fetch',async()=>{
  calls++;return Response.json({Fault:{type:authentication?'AuthenticationFault':'ValidationFault',Error:[{code:authentication?'120':'6000',Message:'PRIVATE_PROVIDER_DETAIL'}]}});
 });
 await assert.rejects(qbo.listPostingParties({credentials,partyType:'customer'}),error=>{
  assert.equal(error.code,'QUICKBOOKS_API_FAULT');assert.equal(failures.accessRejected(error),false);assert.doesNotMatch(error.message,/PRIVATE_PROVIDER_DETAIL/);return true;
 });
 const before=calls;
 await assert.rejects(qbo.postJournalEntry({credentials,idempotencyKey:'qualification-only',entry:{posting_date:'2026-11-22',currency:'USD',entry_number:'Q-1',description:'Qualification',lines:[]}}),error=>error.code==='QUICKBOOKS_API_FAULT');
 assert.equal(calls,before+1,'An unconfirmed accounting write must not be retried');
 authentication=true;
 await assert.rejects(qbo.verifyReadOnly({credentials}),error=>{
  assert.equal(error.status,401);assert.equal(failures.accessRejected(error),true);return true;
 });
});
