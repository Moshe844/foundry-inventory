'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{accessRejected}=require('../../src/connections/provider-sync-failure');
test('provider access refusals exclude temporary, quota and StockChief application failures',()=>{
 assert.equal(accessRejected({status:403,code:'bigcommerce_request_rejected'}),true);assert.equal(accessRejected({status:401}),true);
 for(const error of [{status:403,transient:true},{status:403,retryable:true},{status:403,retryAfterMs:1000},{status:429},{status:503},{status:402},{status:401,providerBody:{error:'invalid_client'}},{status:403,providerBody:{error:'unauthorized_client'}},{status:401,code:'PROVIDER_CONFIGURATION_REQUIRED'}])assert.equal(accessRejected(error),false,JSON.stringify(error));
});
