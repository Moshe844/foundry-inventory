'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const qualification=require('../../src/payments/stripe-live-qualification');
test('live merchant rollout requires the verified platform and never borrows the subscription secret',()=>{
 const before={...process.env};
 try{
  Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'production',STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID:'acct_Platform',
   STOCKCHIEF_BILLING_STRIPE_SECRET_KEY:'rk_live_subscription_fixture',STOCKCHIEF_STRIPE_CONNECT_PLATFORM_ACCOUNT_ID:'acct_Platform',
   STRIPE_CONNECT_CLIENT_ID:'ca_Platform',STRIPE_SECRET_KEY:'sk_live_platform_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',
   STOCKCHIEF_STRIPE_CONNECT_ENABLED:'0',STOCKCHIEF_STRIPE_CONNECT_PILOT_WORKSPACES:'wsp_pilot'});
  assert.equal(qualification.configured(),true);assert.equal(qualification.allowed('wsp_pilot'),true);assert.equal(qualification.allowed('wsp_other'),false);
  const account={id:'acct_Merchant',type:'standard',charges_enabled:true,controller:{type:'account'}};
  const proof=qualification.evidence(account,{accountId:account.id,liveMode:true});
  assert.equal(qualification.valid(proof,account.id),true);assert.equal(qualification.valid(proof,'acct_Other'),false);
  for(const changed of [{livemode:false},{id:'acct_Other'},{type:'express'},{controller:{fees:{payer:'application'}}},
   {controller:{losses:{payments:'application'}}},{controller:{stripe_dashboard:{type:'express'}}},{controller:{requirement_collection:'application'}}]){
   assert.throws(()=>qualification.evidence({...account,...changed},{accountId:account.id,liveMode:true}),/Stripe/);
  }
  assert.throws(()=>qualification.evidence(account,{accountId:account.id,liveMode:false}),/live merchant/);
  assert.throws(()=>qualification.evidence({...account,id:'acct_Platform'},{accountId:'acct_Platform',liveMode:true}),/separate live merchant/);
  process.env.STOCKCHIEF_STRIPE_CONNECT_ENABLED='1';assert.equal(qualification.allowed('wsp_other'),true);
  for(const key of ['STRIPE_CONNECT_CLIENT_ID','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STOCKCHIEF_STRIPE_CONNECT_PLATFORM_ACCOUNT_ID']){
   const held=process.env[key];delete process.env[key];assert.equal(qualification.configured(),false,key);assert.equal(qualification.allowed('wsp_pilot'),false,key);
   assert.equal(qualification.valid(proof,account.id),true,'Pausing new connections must not invalidate an existing verified financial arrangement');process.env[key]=held;
  }
  process.env.STRIPE_SECRET_KEY='sk_test_platform';assert.equal(qualification.configured(),false);
  process.env.STOCKCHIEF_STRIPE_CONNECT_PLATFORM_ACCOUNT_ID='acct_Foreign';assert.equal(qualification.configured(),false);
 }finally{process.env=before;}
});
