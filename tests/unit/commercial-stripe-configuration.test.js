'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const configuration=require('../../src/commercial/stripe-configuration');
const url='https://stockchief.example.test/webhooks/stockchief-billing/stripe';
const good={id:'we_fixture',url,status:'enabled',livemode:false,api_version:'2026-09-30.endive',enabled_events:[...configuration.REQUIRED_EVENTS]};
test('readiness rejects missing top-up/refund events and unpinned webhook versions',()=>{
 const bad=configuration.inspectEndpoint({...good,api_version:null,enabled_events:['invoice.paid']},url);
 assert.equal(bad.ready,false);assert.ok(bad.missingEvents.includes('payment_intent.succeeded'));
 assert.ok(bad.missingEvents.includes('refund.created'));assert.ok(bad.issues.includes('WEBHOOK_API_VERSION_UNPINNED'));
 assert.equal(configuration.inspectEndpoint(good,url).ready,true);
 assert.ok(configuration.inspectEndpoint({...good,api_version:'2026-08-26.dahlia'},url).issues.includes('WEBHOOK_API_VERSION_MISMATCH'));
});
test('audit paginates and refuses multiple enabled destinations',async()=>{
 let calls=0;const result=await configuration.audit({expectedUrl:url,call:async()=>++calls===1?
  {data:[good],has_more:true}:{data:[{...good,id:'we_duplicate'}],has_more:false}});
 assert.equal(calls,2);assert.equal(result.ready,false);assert.deepEqual(result.issues,['MULTIPLE_ACTIVE_WEBHOOKS']);
});
test('event repair refuses live keys and preserves existing event subscriptions',async()=>{
 await assert.rejects(()=>configuration.repairTestEvents('we_fixture',{secretKey:'sk_live_fixture'}),/TEST key/);
 let values;const result=await configuration.repairTestEvents('we_fixture',{expectedUrl:url,secretKey:'sk_test_fixture',
  call:async(route,options)=>{if(options.method==='GET')return {...good,enabled_events:['invoice.upcoming']};
   values=Object.values(options.values);return {...good,enabled_events:values};}});
 assert.equal(result.ready,true);assert.ok(values.includes('invoice.upcoming'));
 assert.ok(values.includes('payment_intent.succeeded'));assert.ok(values.includes('refund.created'));
});
