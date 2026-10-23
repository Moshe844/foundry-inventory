'use strict';const test=require('node:test'),assert=require('node:assert/strict'),rules=require('../../src/shipping/rules');
test('shipping rules require known delivery estimates and enforce weight and currency conditions',()=>{
 const rates=[{id:'unknown',carrier:'usps',service:'Ground',amountMinor:100,currency:'USD',deliveryDays:null},{id:'known',carrier:'usps',service:'Ground',amountMinor:200,currency:'USD',deliveryDays:3}],rule={name:'Measured light parcels',maxCostMinor:500,maxDeliveryDays:4,maxWeightGrams:450,minWeightGrams:1,currency:'USD'};
 assert.equal(rules.decide(null,'business',rates,{rules:[rule],weightGrams:300}).rate.id,'known');assert.equal(rules.decide(null,'business',rates,{rules:[rule],weightGrams:500}).rate,null);assert.equal(rules.decide(null,'business',rates.map(r=>({...r,currency:'CAD'})),{rules:[rule],weightGrams:300}).rate,null);
});
