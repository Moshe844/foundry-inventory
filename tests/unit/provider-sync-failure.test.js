'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{accessRejected}=require('../../src/connections/provider-sync-failure');
test('provider access refusals exclude temporary, quota and StockChief application failures',()=>{
 assert.equal(accessRejected({status:403,code:'bigcommerce_request_rejected'}),true);assert.equal(accessRejected({status:401}),true);
 for(const error of [{status:403,transient:true},{status:403,retryable:true},{status:403,retryAfterMs:1000},{status:429},{status:503},{status:402},{status:401,providerBody:{error:'invalid_client'}},{status:403,providerBody:{error:'unauthorized_client'}},{status:401,code:'PROVIDER_CONFIGURATION_REQUIRED'}])assert.equal(accessRejected(error),false,JSON.stringify(error));
});

test('customer sync explanations use known causes and never display raw provider secrets',()=>{
 const failure=require('../../src/connections/provider-sync-failure'),presentation=require('../../src/web/presentation/connections');
 for(const code of ['SHOPIFY_SESSION_LOCK_UNAVAILABLE','SHOPIFY_AUTHORIZATION_BUSY','PROVIDER_UNREACHABLE']){
  const error={code,message:'private access_token=secret'};assert.equal(failure.failureCode(error),code);
  const text=presentation.issue({status:'connected',publicStatus:'Needs attention',last_error:error.message,config:{syncFailureCode:code}});
  assert(text.length>30);assert(!text.includes('secret'));assert.match(text,/retry/i);
 }
 assert.equal(failure.failureCode({status:429}),'PROVIDER_RATE_LIMITED');
 assert.equal(failure.explanation({syncFailureCode:'<script>private</script>'}),null);
 assert(!presentation.issue({status:'connected',publicStatus:'Needs attention',last_error:'private access_token=secret',config:{}}).includes('secret'));
});
