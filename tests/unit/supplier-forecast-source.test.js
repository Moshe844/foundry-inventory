'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{weeks,monday}=require('../../src/purchasing/supplier-forecast-source');
test('a fitted forecast shape becomes twelve seven-day weeks from the preparation day',()=>{
 const plan=weeks({kind:'flat',rate:2},'2026-11-11');
 assert.equal(plan.length,12);assert.deepEqual(plan[0],{from:'2026-11-11',to:'2026-11-17',quantity:14});assert.equal(plan[11].to,'2027-02-02');
 assert(plan.every(w=>w.quantity===14));
 const weekday=weeks({kind:'weekday',rate:1,factors:[0,1,1,1,1,1,2]},'2026-11-09');assert(weekday.every(w=>w.quantity===7),'a weekday pattern sums to the same week');
});
test('a product without a forecast stays unknown instead of inventing demand',()=>{
 const plan=weeks(null,'2026-11-11');assert.equal(plan.length,12);assert(plan.every(w=>w.quantity===null));
});
test('a week is counted from its Monday',()=>{
 assert.equal(monday('2026-11-11'),'2026-11-09');assert.equal(monday('2026-11-09'),'2026-11-09');assert.equal(monday('2026-11-15'),'2026-11-09');
});
