'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../../src/connections/synchronization-policy');
test('provider cadence retains requested timing, respects off and Xero allowance, and does not invent a completed check',()=>{
 const now=Date.parse('2026-10-21T15:00:00Z'),row={status:'connected',provider_type:'xero',expected_interval_minutes:1,created_at:new Date(now).toISOString(),config:'{}'};
 const result=policy.describe(row,{discover(){}},now);
 assert.equal(result.requestedMinutes,1);assert.equal(result.effectiveMinutes,5);assert.equal(result.lastCheckAt,null);
 assert.equal(result.nextCheckAt,'2026-10-21T15:05:00.000Z');
 assert.equal(policy.describe({...row,provider_type:'clover',last_synced_at:'2026-10-21T15:00:09.000Z'},{discover(){}},now).nextCheckAt,
   '2026-10-21T15:01:00.000Z','finishing seconds after a scheduler tick must not defer the next check by another minute');
 assert.equal(policy.describe({...row,config:'{"syncDisabled":true}'},{discover(){}},now).nextCheckAt,null);
 assert.equal(policy.describe({...row,paused_at:row.created_at},{discover(){}},now).mode,'paused');
 assert.equal(policy.describe({...row,status:'disconnected'},{discover(){}},now).mode,'disconnected');
 assert.throws(()=>policy.interval(0));assert.throws(()=>policy.interval('abc'));
});
test('a long provider Retry-After is deferred without an early second request',async()=>{
 const {providerFetch}=require('../../src/lib/provider-http');let calls=0;
 await assert.rejects(providerFetch('https://example.test/',{}, {provider:'Fixture',fetch:async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'180'}});},sleep:async()=>{throw Error('must defer');}}),e=>e.retryAfterMs===180000&&e.httpStatus===429);
 assert.equal(calls,1);
});
test('a successful check crossing a clock boundary retains its next cadence slot and provider cooldown',()=>{
 const row={status:'connected',provider_type:'clover',expected_interval_minutes:1,created_at:'2026-10-21T15:00:00.000Z',
  last_synced_at:'2026-10-21T15:03:01.000Z',config:{syncCadenceStartedAt:'2026-10-21T15:02:57.000Z'}};
 const adapter={discover(){}};
 assert.equal(policy.describe(row,adapter).nextCheckAt,'2026-10-21T15:03:00.000Z');
 assert.equal(policy.describe({...row,config:{...row.config,syncRetryAt:'2026-10-21T15:06:00.000Z'}},adapter).nextCheckAt,'2026-10-21T15:06:00.000Z');
 assert.equal(policy.describe({...row,config:{syncCadenceStartedAt:'not-a-date'}},adapter).nextCheckAt,'2026-10-21T15:04:00.000Z');
 assert.equal(policy.describe({...row,config:{syncCadenceStartedAt:'2026-10-21T15:09:00.000Z'}},adapter).nextCheckAt,'2026-10-21T15:04:00.000Z');
 assert.equal(policy.describe({...row,provider_type:'gmail'}, {poll(){}}).nextCheckAt,'2026-10-21T15:03:00.000Z');
 assert.equal(policy.describe({...row,expected_interval_minutes:5},adapter).nextCheckAt,'2026-10-21T15:07:00.000Z',
  'longer intervals remain relative to the last check instead of shortening to a global five-minute boundary');
 assert.equal(policy.describe({...row,provider_type:'xero'},adapter).nextCheckAt,'2026-10-21T15:07:00.000Z');
});
