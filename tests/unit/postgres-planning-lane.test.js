'use strict';const test=require('node:test'),assert=require('node:assert/strict');
const handlers=require('../../src/operations/postgres-runtime-handlers');
test('large-inventory planning retains its transaction and has a separate bounded lane',()=>{
 const registered=handlers.create();assert.equal(registered['autopilot.evaluate'].workerLane,'planning');assert.notEqual(registered['autopilot.evaluate'].externalEffect,true);assert.equal(registered['provider.catalog-sync'].workerLane,undefined);assert.equal(registered['provider.effect'].workerLane,undefined);assert.equal(registered['import.execute-approved'].workerLane,'bulk');
});
test('held planning does not prevent repeated provider synchronization and each lane stays single-flight',async()=>{
 const queue=require('../../src/operations/postgres-job-queue'),original=queue.processOne,registered=handlers.create();let release;const held=new Promise(r=>{release=r;}),active={},maximum={},calls={};
 queue.processOne=async(_db,lane)=>{const key=Object.keys(lane).includes('autopilot.evaluate')?'planning':Object.keys(lane).includes('provider.catalog-sync')?'sync':'bulk';calls[key]=(calls[key]||0)+1;active[key]=(active[key]||0)+1;maximum[key]=Math.max(maximum[key]||0,active[key]);try{if(key==='planning')await held;}finally{active[key]--;}};
 const worker=require('../../src/operations/postgres-worker').start({},{handlers:{'autopilot.evaluate':registered['autopilot.evaluate'],'provider.catalog-sync':registered['provider.catalog-sync'],'import.execute-approved':registered['import.execute-approved']},intervalMs:60000});
 try{await new Promise(r=>setImmediate(r));assert.equal(calls.planning,1);assert.equal(calls.sync,1);worker.wake();await new Promise(r=>setTimeout(r,30));assert.equal(calls.planning,1);assert.equal(calls.sync,2);assert.equal(maximum.planning,1);assert.equal(maximum.sync,1);assert.equal(maximum.bulk,1);}finally{release();await worker.stop();queue.processOne=original;}
});
