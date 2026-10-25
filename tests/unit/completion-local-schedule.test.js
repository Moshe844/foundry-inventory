'use strict';const test=require('node:test'),assert=require('node:assert/strict');
test('daily and weekly report clocks preserve local hour and minute across daylight saving',()=>{
 const clock=require('../../src/reports/local-schedule');let s=clock.normalize({frequency:'weekly',hour:7,minute:35,weekday:4,timeZone:'America/New_York'},'UTC');assert.equal(clock.next(s,new Date('2027-03-10T16:00:00Z')).toISOString(),'2027-03-11T12:35:00.000Z');assert.equal(clock.next(s,new Date('2027-03-11T12:35:00Z')).toISOString(),'2027-03-18T11:35:00.000Z');s=clock.normalize({frequency:'daily',hour:7,minute:5},'Asia/Kathmandu');assert.equal(clock.next(s,new Date('2027-06-01T00:00:00Z')).toISOString(),'2027-06-01T01:20:00.000Z');
});
test('a missing spring-forward wall time advances to the next valid minute; a repeated fall time sends once',()=>{
 const clock=require('../../src/reports/local-schedule');const spring=clock.normalize({frequency:'daily',hour:2,minute:30},'America/New_York');assert.equal(clock.next(spring,new Date('2027-03-14T05:00:00Z')).toISOString(),'2027-03-14T07:00:00.000Z');const fall=clock.normalize({frequency:'daily',hour:1,minute:30},'America/New_York');assert.equal(clock.next(fall,new Date('2027-11-07T04:00:00Z')).toISOString(),'2027-11-07T05:30:00.000Z');assert.equal(clock.next(fall,new Date('2027-11-07T05:45:00Z')).toISOString(),'2027-11-08T06:30:00.000Z');
});
