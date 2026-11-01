'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const tick=()=>new Promise(r=>setImmediate(r));
test('fatal failures stop accepting work, record a private incident and exit for supervisor restart',async()=>{
 const runtime=new EventEmitter(),output=[],exits=[],events=[];let stops=0;runtime.stderr={write:text=>output.push(text)};runtime.exit=code=>exits.push(code);
 const remove=require('../../src/operations/crash-monitor').install({runtime,release:'test-release',stop:()=>stops++,record:async event=>events.push(event)});
 const error=Object.assign(new Error('Do not log customer-secret-token'),{code:'FIXTURE_FAILURE'});runtime.emit('unhandledRejection',error);await tick();
 assert.equal(stops,1);assert.deepEqual(exits,[1]);assert.equal(events[0].code,'FIXTURE_FAILURE');assert(!JSON.stringify(output).includes('customer-secret-token'));remove();assert.equal(runtime.listenerCount('unhandledRejection'),0);assert.equal(runtime.listenerCount('uncaughtException'),0);
});
test('an unavailable incident store cannot keep a failed process serving requests',async()=>{
 const runtime=new EventEmitter(),exits=[];runtime.stderr={write:()=>{}};runtime.exit=code=>exits.push(code);const remove=require('../../src/operations/crash-monitor').install({runtime,timeoutMs:100,record:()=>new Promise(()=>{})});
 runtime.emit('uncaughtException',new Error('fixture'));await new Promise(r=>setTimeout(r,130));assert.deepEqual(exits,[1]);remove();
});
