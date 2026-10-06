'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {gmailQuota}=require('../../src/commercial/network');
const {providerFetch}=require('../../src/lib/provider-http');
const base='https://gmail.googleapis.com/gmail/v1/users/me';
test('only existing Stripe Billing/Payments REST paths are evidenced as non-incremental HTTP attempts',()=>{
 const {classify}=require('../../src/commercial/stripe-request-classification');
 for(const path of ['/v1/checkout/sessions','/v1/invoices/in_test','/v1/invoices/create_preview',
  '/v1/payment_intents/pi_test','/v1/subscription_schedules','/v1/balance_transactions/txn_test']){
  const result=classify(`https://api.stripe.com${path}`);
  assert.equal(result?.basis,'VERIFIED_NO_INCREMENTAL_REQUEST_FEE');
  assert.match(result.source,/stripe\.com\/billing\/pricing/);
 }
 assert.equal(classify('https://api.stripe.com/v1/tax/calculations'),null);
 assert.equal(classify('https://example.test/v1/invoices/in_test'),null);
});
test('initial self-service launch rejects annual without changing legacy annual webhook support',()=>{
 const {assertMonthly}=require('../../src/commercial/launch-interval');
 assert.equal(assertMonthly('monthly'),'MONTHLY');
 assert.equal(assertMonthly(),'MONTHLY');
 assert.throws(()=>assertMonthly('annual'),/Annual billing is not available/);
 assert.throws(()=>assertMonthly('ANNUAL'),/Annual billing is not available/);
});
test('Gmail provider attempts retain official method-specific quota units without storing message IDs',()=>{
 for(const [path,verb,method,units] of [
  ['/profile','GET','getProfile',1],['/watch','POST','watch',100],['/history','GET','history.list',2],
  ['/messages?q=in%3Ainbox','GET','messages.list',5],['/messages/msg-secret','GET','messages.get',20],
  ['/messages/msg-secret/attachments/attachment-secret','GET','messages.attachments.get',20],
  ['/messages/send','POST','messages.send',100],
 ])assert.deepEqual(gmailQuota(`${base}${path}`,verb),{method,units});
 assert.equal(gmailQuota(`${base}/messages/send`,'GET'),null);
 assert.equal(gmailQuota('https://oauth2.googleapis.com/token','POST'),null);
 assert.equal(gmailQuota('https://graph.microsoft.com/v1.0/me/messages','GET'),null);
});
test('PostgreSQL cannot make an unscoped connected-provider HTTP call',async()=>{
 const prior=process.env.FOUNDRY_DATABASE_URL;process.env.FOUNDRY_DATABASE_URL='postgres://commercial-guard.test/unused';
 let called=false;
 try{await assert.rejects(()=>providerFetch('https://api.easypost.com/v2/shipments',{},
  {provider:'EasyPost',fetch:async()=>{called=true;throw Error('Provider should not be reached');}}),
 /no commercial operation scope/);assert.equal(called,false);}
 finally{if(prior===undefined)delete process.env.FOUNDRY_DATABASE_URL;else process.env.FOUNDRY_DATABASE_URL=prior;}
});
test('PostgreSQL cannot invoke the Anthropic SDK without a commercial model hold',async()=>{
 const prior=process.env.FOUNDRY_DATABASE_URL;process.env.FOUNDRY_DATABASE_URL='postgres://commercial-guard.test/unused';
 try{const provider=require('../../src/ai/providers/anthropic').create({apiKey:'test-only-not-a-real-key',
  model:'claude-haiku-4-5-20251001',effort:'none',maxTokens:100});
  await assert.rejects(()=>provider.complete({system:'test',prompt:'test',schema:{type:'object'}}),
   error=>error.code==='commercial_meter_required');}
 finally{if(prior===undefined)delete process.env.FOUNDRY_DATABASE_URL;else process.env.FOUNDRY_DATABASE_URL=prior;}
});
