'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {periodBounds}=require('../../src/commercial/entitlements');
test('annual monthly allowances stay within the paid term for test clocks and delayed renewals',()=>{
 const subscription={billing_interval:'ANNUAL',current_period_start:'2028-01-31T10:15:00Z',current_period_end:'2029-01-31T10:15:00Z'};
 for(const [at,start,end] of [
  ['2027-10-30T00:00:00Z','2028-01-31T10:15:00Z','2028-02-29T10:15:00Z'],
  ['2028-03-01T00:00:00Z','2028-02-29T10:15:00Z','2028-03-31T10:15:00Z'],
  ['2029-02-15T00:00:00Z','2028-12-31T10:15:00Z','2029-01-31T10:15:00Z']]){
  const result=periodBounds(subscription,new Date(at));assert.equal(result.start.toISOString(),new Date(start).toISOString());assert.equal(result.end.toISOString(),new Date(end).toISOString());assert(result.start<result.end);
 }
});
