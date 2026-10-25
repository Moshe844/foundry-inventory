'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('calendar-month rental periods retain the original anchor through February and DST',()=>{
 const {period}=require('../../src/custody/rental-periods'),p={anchor_at:'2027-01-31T15:15:00.000Z',time_zone:'America/New_York',interval_unit:'MONTH',amount_minor:1000,prorate_final:true};
 assert.equal(period(p,0).endsAt,'2027-02-28T15:15:00.000Z');
 assert.equal(period(p,1).endsAt,'2027-03-31T14:15:00.000Z');
 assert.equal(period({...p,anchor_at:'2028-01-31T15:15:00.000Z'},0).endsAt,'2028-02-29T15:15:00.000Z');
 const daily={...p,anchor_at:'2027-03-13T15:15:00.000Z',interval_unit:'DAY'};
 assert.equal(period(daily,0).endsAt,'2027-03-14T14:15:00.000Z');
 const final=period({...daily,stopped_at:'2027-03-14T02:45:00.000Z'},0);assert.equal(final.amountMinor,500);assert.equal(final.final,true);
 assert.equal(period({...p,stopped_at:p.anchor_at},0),null);
 assert.equal(period({...p,anchor_at:'2026-11-01T06:30:00.000Z'},0).startsAt,'2026-11-01T06:30:00.000Z','The second 1:30 AM during the autumn fold stays the actual dispatch instant');
});
