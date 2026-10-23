'use strict';const test=require('node:test'),assert=require('node:assert/strict');
test('provider void confirmation does not invent a refunded amount or bank credit',async()=>{
 const previous=global.fetch;global.fetch=async(url,input)=>({ok:true,status:200,text:async()=>JSON.stringify(String(url).includes('easypost')?{id:'label-one',refund_status:input.method==='POST'?'submitted':'refunded'}:
  String(url).includes('shipstation')?(input.method==='PUT'?{approved:true,message:'Refund submitted. Label voided.'}:{voided:true}):
   String(url).includes('/refunds/')?{object_id:'refund-one',status:'QUEUED'}:{object_id:'label-one',status:'REFUNDED'})});
 try{
  for(const provider of ['easypost','shipstation','shippo']){
   const adapter=require('../../src/shipping/providers/'+provider),ctx={[provider+'ApiKey']:'test_void_fixture'},input={providerReferences:['label-one'],idempotencyKey:'one-void'};
   const submitted=await adapter.voidLabel(ctx,input);assert.equal(submitted.status,provider==='shipstation'?'SUCCEEDED':'PENDING');
   const verified=await adapter.verifyVoid(ctx,input);assert.equal(verified.status,'SUCCEEDED');assert.equal(verified.refundAmountMinor,undefined);
   assert.equal(verified.refundStatus,provider==='shipstation'?'PENDING':'CONFIRMED');
  }
 }finally{global.fetch=previous;}
});
test('ShipStation requires an affirmative void result rather than treating a missing boolean as success',async()=>{
 const previous=global.fetch;global.fetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify({message:'Processing'})});
 try{assert.equal((await require('../../src/shipping/providers/shipstation').voidLabel({shipstationApiKey:'TEST_fixture'},{providerReferences:['label-one']})).status,'PENDING');}finally{global.fetch=previous;}
});
for(const provider of ['easypost','shipstation','shippo'])test(provider+' never resubmits an uncertain void HTTP write',async()=>{
 const previous=global.fetch;let count=0;global.fetch=async()=>{count++;return {ok:false,status:503,headers:{get:()=>null},text:async()=>JSON.stringify({})};};
 try{await assert.rejects(require('../../src/shipping/providers/'+provider).voidLabel({[provider+'ApiKey']:'test_fixture'},{providerReferences:['label-one'],idempotencyKey:'one-void'}));assert.equal(count,1);}finally{global.fetch=previous;}
});
for(const provider of ['easypost','shipstation','shippo'])test(provider+' retains partial multi-package voids for verification',async()=>{
 const previous=global.fetch;let n=0;global.fetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify(++n===1?
  provider==='easypost'?{refund_status:'refunded'}:provider==='shipstation'?{approved:true}:{status:'SUCCESS'}:
  provider==='easypost'?{refund_status:'rejected'}:provider==='shipstation'?{approved:false}:{status:'REJECTED'})});
 try{assert.equal((await require('../../src/shipping/providers/'+provider).voidLabel({[provider+'ApiKey']:'test_fixture'},{providerReferences:['label-a','label-b']})).status,'PENDING');}finally{global.fetch=previous;}
});
