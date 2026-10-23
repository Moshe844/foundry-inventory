'use strict';const test=require('node:test'),assert=require('node:assert/strict');
test('provider amounts use canonical currency precision, preserve zero and refuse unknown values',()=>{
 const easy=require('../../src/shipping/providers/easypost'),po=require('../../src/shipping/providers/shippo'),station=require('../../src/shipping/providers/shipstation');
 for(const [currency,raw,minor]of [['USD','9.99',999],['JPY','999',999],['KWD','0.125',125],['USD','0',0]]){
  assert.equal(easy.readRate({id:'r',rate:raw,currency}).amountMinor,minor);assert.equal(po.readRate({object_id:'r',amount:raw,currency}).amountMinor,minor);assert.equal(station.readRate({rate_id:'r',shipping_amount:{currency,amount:raw}}).amountMinor,minor);
 }
 for(const build of [()=>easy.readRate({rate:'9.999',currency:'USD'}),()=>po.readRate({amount:'5'}),()=>station.readRate({rate_id:'r'}),()=>station.readRate({shipping_amount:{amount:1,currency:'USD'},insurance_amount:{amount:1,currency:'EUR'}})])assert.throws(build);
});
test('a malformed receipt after a successful external write is uncertain rather than permission to buy again',()=>{
 const money=require('../../src/shipping/provider-money');assert.throws(()=>money.receipt({externalId:'verified-carrier-id'},()=>money.total([{amount:'9.999',currency:'USD'}])),error=>error.providerOutcomeUncertain&&error.providerReference.externalId==='verified-carrier-id');
});
