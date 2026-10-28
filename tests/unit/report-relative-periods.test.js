'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const dates=require('../../src/reports/relative-dates');
test('report date choices use the business calendar across leap years and months',()=>{
  const calendar={calendarDate:'2028-02-29',timeZone:'America/New_York'};
  assert.deepEqual(dates.bounds('last 30 days',calendar),{from:'2028-01-31',to:'2028-02-29'});
  assert.deepEqual(dates.bounds('last 90 days',calendar),{from:'2027-12-02',to:'2028-02-29'});
  assert.deepEqual(dates.bounds('last month',calendar),{from:'2028-01-01',to:'2028-01-31'});
  assert.deepEqual(dates.bounds('year to date',calendar),{from:'2028-01-01',to:'2028-02-29'});
  assert.deepEqual(dates.bounds('last month',{calendarDate:'2028-01-02',timeZone:'America/New_York'}),
    {from:'2027-12-01',to:'2027-12-31'});
});
