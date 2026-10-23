'use strict';const test=require('node:test'),assert=require('node:assert/strict');
test('multi-parcel rates only combine a common service and account in the same currency',()=>{
 const combine=require('../../src/shipping/parcel-rates').combine;
 const r=(id,amount,currency='USD',carrierAccount='a')=>({rateId:id,carrier:'ups',service:'Ground',carrierAccount,amountMinor:amount,currency,deliveryDays:2});
 const groups=[{providerShipmentIds:['a'],rates:[r('a1',100)]},{providerShipmentIds:['b'],rates:[r('b1',200)]}];
 const result=combine(groups);assert.equal(result.rates[0].amountMinor,300);assert.deepEqual(result.rates[0].rateIds,['a1','b1']);assert.deepEqual(result.providerShipmentIds,['a','b']);
 assert.equal(combine([groups[0],{rates:[r('b',200,'EUR')]}]).rates.length,0);
 assert.equal(combine([groups[0],{rates:[r('b',200,'USD','other')]}]).rates.length,0);
});
test('EasyPost webhook rotation uses the documented PATCH envelope',async()=>{
 const requests=[],api=async(_ctx,path,input={})=>{requests.push({path,...input});return path==='/webhooks'?{webhooks:[{id:'hook',url:'https://example.test/events'}]}:{id:'hook'};};
 await require('../../src/shipping/providers/webhook-registration').easypost(api,{}, {url:'https://example.test/events',webhookSecret:'test-secret'});
 assert.deepEqual(requests[1].body,{webhook_secret:'test-secret'});
});
test('carrier MIME print types become the canonical printer formats',()=>{
 const {format}=require('../../src/shipping/parcel-contract');assert.equal(format('application/pdf'),'PDF');assert.equal(format('application/zpl'),'ZPL');assert.equal(format('ZPLII'),'ZPL');assert.equal(format(null,'https://example.test/actual.zpl?token=private'),'ZPL');assert.throws(()=>format('image/gif'),/unsupported/);
});
