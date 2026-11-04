'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{readableTimes,ordered,COMMON}=require('../../src/web/presentation/time-zones');
test('a timestamp inside a sentence reads as a date in the business zone',()=>{
 assert.equal(readableTimes('Last order pull failed at 2026-10-27T13:24:39.558Z.','America/New_York'),'Last order pull failed at Oct 27, 9:24 AM.');
 assert.equal(readableTimes('No stamp, order T-100 from 2026-10-27.','America/New_York'),'No stamp, order T-100 from 2026-10-27.');
 assert.equal(readableTimes(null,'UTC'),null);
});
test('the saved zone comes first, then common US zones, and UTC is last',()=>{
 const list=ordered('Europe/London');assert.equal(list[0],'Europe/London');assert.deepEqual(list.slice(1,COMMON.length+1),[...COMMON]);assert.equal(list.at(-1),'UTC');assert.equal(new Set(list).size,list.length);
 assert.equal(ordered(null)[0],'America/New_York');
});
