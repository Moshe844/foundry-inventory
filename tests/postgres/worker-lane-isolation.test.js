'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('PostgreSQL workers claim routine jobs during held bulk work without duplicate execution',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString,{max:5});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 let release,bulkStarted;const held=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{bulkStarted=resolve;});
 const jobs=require('../../src/operations/postgres-job-queue'),calls={bulk:0,routine:0};
 const bulk=async()=>{calls.bulk++;bulkStarted();await held;return {verified:true};};bulk.externalEffect=true;bulk.workerLane='bulk';
 const routine=async()=>{calls.routine++;return {verified:true};};routine.externalEffect=true;
 const b=await jobs.enqueue(db,{kind:'fixture.bulk',idempotencyKey:'bulk'});
 const worker=require('../../src/operations/postgres-worker').start(db,{owner:'lane-certification',intervalMs:20,leaseMs:60000,handlers:{'fixture.bulk':bulk,'fixture.routine':routine}});
 t.after(async()=>{release();await worker.stop();await db.close();await cluster.stop();});
 await started;
 const r=await jobs.enqueue(db,{kind:'fixture.routine',idempotencyKey:'routine'});
 let state;for(const end=Date.now()+5000;Date.now()<end;){state=await jobs.get(db,r.job.id,null);if(state.status==='COMPLETED')break;await new Promise(resolve=>setTimeout(resolve,20));}
 assert.equal(state.status,'COMPLETED');assert.equal((await jobs.get(db,b.job.id,null)).status,'RUNNING');
 assert.deepEqual(calls,{bulk:1,routine:1});
 release();for(const end=Date.now()+5000;Date.now()<end;){state=await jobs.get(db,b.job.id,null);if(state.status==='COMPLETED')break;await new Promise(resolve=>setTimeout(resolve,20));}
 assert.equal(state.status,'COMPLETED');await worker.stop();assert.deepEqual(calls,{bulk:1,routine:1});
});
