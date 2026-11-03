'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),contract=require('../../src/commercial/usage-operation-contract');
test('polling, authorization, source backfills and comparisons do not consume Connected Operations',()=>{for(const operation of contract.reads)assert.equal(contract.category(operation),null,operation);});
test('external business mutations, sending and webhook resources have distinct meters',()=>{for(const operation of contract.writes)assert.equal(contract.category(operation),'connected_operations');assert.equal(contract.category('outbound_email'),'emails_sent');assert.equal(contract.category('reply_email'),'emails_sent');assert.equal(contract.category('outbound_webhook'),'api_requests');assert.throws(()=>contract.category('unknown_mutation'),/registered usage contract/);});
test('only definite commerce rejections release a write reservation for retry',()=>{
 assert.equal(contract.definiteRejection('commerce_position_publish',{status:429}),true);
 assert.equal(contract.definiteRejection('commerce_position_publish',{status:409,providerWriteAttempted:false}),true);
 for(const error of [{status:429,providerOutcomeUncertain:true},{status:409},{status:503},new Error('lost acknowledgement')])assert.equal(contract.definiteRejection('commerce_position_publish',error),false);
 assert.equal(contract.definiteRejection('invoice_create',{status:429}),false);
});
