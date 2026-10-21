'use strict';
const test=require('node:test'),assert=require('node:assert/strict');

test('an active bulk job does not starve routine work and shutdown waits for both lanes',async()=>{
 const queue=require('../../src/operations/postgres-job-queue'),original=queue.processOne;
 const counts={bulk:0,routine:0},inflight={bulk:0,routine:0},maximum={bulk:0,routine:0};
 let release,stopped=false;
 const held=new Promise(resolve=>{release=resolve;});
 const bulk=async()=>{},routine=async()=>{};bulk.workerLane='bulk';
 queue.processOne=async(db,handlers)=>{
  const lane=handlers['fixture.bulk']?'bulk':'routine';
  assert.deepEqual(Object.keys(handlers),[lane==='bulk'?'fixture.bulk':'fixture.routine']);
  counts[lane]++;inflight[lane]++;maximum[lane]=Math.max(maximum[lane],inflight[lane]);
  try{if(lane==='bulk')await held;}finally{inflight[lane]--;}
 };
 const worker=require('../../src/operations/postgres-worker').start({},{owner:'test-worker',intervalMs:60000,
  handlers:{'fixture.bulk':bulk,'fixture.routine':routine}});
 try{
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(counts,{bulk:1,routine:1});
  worker.wake();worker.wake();await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(counts.bulk,1);assert(counts.routine>=2);assert.deepEqual(maximum,{bulk:1,routine:1});
  const stopping=worker.stop().then(()=>{stopped=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);
  const before={...counts};worker.wake();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(counts,before);
  release();await stopping;assert.equal(stopped,true);assert.deepEqual(inflight,{bulk:0,routine:0});
 }finally{release();await worker.stop();queue.processOne=original;}
});

test('approved imports declare the bulk lane without changing provider or business handlers',()=>{
 const handlers=require('../../src/operations/postgres-runtime-handlers').create();
 assert.equal(handlers['import.execute-approved'].workerLane,'bulk');
 assert.equal(handlers['provider.catalog-sync'].workerLane,undefined);
 assert.equal(handlers['provider.catalog-sync'].externalEffect,true);
 assert.equal(handlers['import.execute-approved'].externalEffect,true);
});
