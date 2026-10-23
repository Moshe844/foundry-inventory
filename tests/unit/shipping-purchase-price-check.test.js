'use strict';const test=require('node:test'),assert=require('node:assert/strict');
test('all postage adapters refuse increased prices before any charge-changing write',async()=>{
 const previous=global.fetch;let writes=0;global.fetch=async(url,init={})=>{if(init.method==='POST')writes++;const host=new URL(url).hostname;
  const body=host.includes('easypost')?{rates:[{id:'r',rate:'9.00',currency:'USD'}]}:host.includes('shipstation')?{rate_id:'r',shipping_amount:{amount:9,currency:'USD'}}:{object_id:'r',amount:'9.00',currency:'USD'};return {ok:true,status:200,text:async()=>JSON.stringify(body)};};
 try{for(const provider of ['easypost','shipstation','shippo'])await assert.rejects(require('../../src/shipping/providers/'+provider).buy({[provider+'ApiKey']:'test_fixture'},{rateIds:['r'],providerShipmentIds:['shipment'],approvedAmountMinor:500,currency:'USD'}),/price increased|price.*changed/i);assert.equal(writes,0);}finally{global.fetch=previous;}
});
