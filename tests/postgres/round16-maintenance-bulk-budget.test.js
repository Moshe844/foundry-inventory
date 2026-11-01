'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('maintenance yields between batches during bulk work, while routine jobs and durable continuation remain available',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString,{max:5});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const jobs=require('../../src/operations/postgres-job-queue');let release,started,worker;const held=new Promise(r=>{release=r;}),began=new Promise(r=>{started=r;}),calls={bulk:0,maintenance:0,routine:0};t.after(async()=>{release();await worker?.stop();await db.close();await cluster.stop();});
 const bulk=Object.assign(async()=>{calls.bulk++;started();await held;return {verified:true};},{workerLane:'bulk',externalEffect:true});
 const maintenance=Object.assign(async job=>{calls.maintenance++;return {processed:job.payload.after+250};},{workerLane:'maintenance',externalEffect:true});
 const routine=Object.assign(async()=>{calls.routine++;return {verified:true};},{externalEffect:true});
 const b=await jobs.enqueue(db,{kind:'fixture.bulk-budget',idempotencyKey:'bulk'}),m1=await jobs.enqueue(db,{kind:'fixture.maintenance-budget',idempotencyKey:'first',payload:{after:0}});
 worker=require('../../src/operations/postgres-worker').start(db,{owner:'maintenance-bulk-budget',intervalMs:20,maintenanceBulkIntervalMs:60000,leaseMs:60000,handlers:{'fixture.bulk-budget':bulk,'fixture.maintenance-budget':maintenance,'fixture.routine-budget':routine}});await began;
 async function completed(id){for(const end=Date.now()+10000;Date.now()<end;){const state=await jobs.get(db,id,null);if(state.status==='COMPLETED')return state;await new Promise(r=>setTimeout(r,20));}throw Error('The worker did not complete the expected job');}
 assert.equal((await completed(m1.job.id)).result.processed,250);const m2=await jobs.enqueue(db,{kind:'fixture.maintenance-budget',idempotencyKey:'second',payload:{after:250}}),r=await jobs.enqueue(db,{kind:'fixture.routine-budget',idempotencyKey:'routine'});worker.wake();await completed(r.job.id);for(let n=0;n<4;n++)worker.wake();assert.equal((await jobs.get(db,m2.job.id,null)).status,'PENDING');assert.equal((await jobs.get(db,m2.job.id,null)).attemptCount,0,'A cooperative wait must not consume attempts');assert.equal((await jobs.get(db,b.job.id,null)).status,'RUNNING');
 release();await completed(b.job.id);worker.wake();assert.equal((await completed(m2.job.id)).result.processed,500,'The durable cursor must continue once bulk work ends');await worker.stop();assert.deepEqual(calls,{bulk:1,maintenance:2,routine:1});
});
