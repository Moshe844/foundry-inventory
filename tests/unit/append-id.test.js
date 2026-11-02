'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{newAppendId}=require('../../src/lib/append-id');
test('append receipt identifiers remain unique during bursts and clock rollback, and sort by millisecond',{concurrency:false},()=>{
 const original=Date.now;try{
  Date.now=()=>1793642400000;const first=Array.from({length:50000},()=>newAppendId('mv'));
  assert(first.every(id=>/^mv_[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(id)));assert.equal(new Set(first).size,50000);
  Date.now=()=>1793642400001;const next=newAppendId('mv');assert(first.every(id=>id<next));
  Date.now=()=>1793642399999;const rolled=newAppendId('mv');assert(rolled<first[0]);assert(!first.includes(rolled));
  Date.now=()=>1793642400000;const sameTimeAgain=Array.from({length:50000},()=>newAppendId('mv'));assert.equal(new Set([...first,...sameTimeAgain]).size,100000);
  // Randomness is fresh even at a fixed timestamp and across record types.
  assert.equal(new Set(['mv','grp','pgop','icm'].map(prefix=>newAppendId(prefix).split('_')[1])).size,4);
  Date.now=()=>281474976710655;assert.match(newAppendId('icm'),/^icm_7z{9}[0-9a-hjkmnp-tv-z]{16}$/);
  for(const invalid of [-1,281474976710656,NaN,Infinity]){Date.now=()=>invalid;assert.throws(()=>newAppendId('mv'),RangeError);}
 }finally{Date.now=original;}
});
