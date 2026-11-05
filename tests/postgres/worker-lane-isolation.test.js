'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('storage measurement uses maintenance capacity rather than occupying the import lane',()=>{
 assert.equal(require('../../src/operations/postgres-runtime-handlers').create()['commercial.storage-baseline'].workerLane,'maintenance');
});
test('PostgreSQL workers claim routine jobs during held bulk work without duplicate execution',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString,{max:5});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 let release,bulkStarted,worker;const held=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{bulkStarted=resolve;});
 t.after(async()=>{release();await worker?.stop();await db.close();await cluster.stop();});
 const jobs=require('../../src/operations/postgres-job-queue'),calls={bulk:0,routine:0};
 const bulk=async()=>{calls.bulk++;bulkStarted();await held;return {verified:true};};bulk.externalEffect=true;bulk.workerLane='bulk';
 const routine=async()=>{calls.routine++;return {verified:true};};routine.externalEffect=true;
 const b=await jobs.enqueue(db,{kind:'fixture.bulk',idempotencyKey:'bulk'});
 worker=require('../../src/operations/postgres-worker').start(db,{owner:'lane-certification',intervalMs:20,leaseMs:60000,handlers:{'fixture.bulk':bulk,'fixture.routine':routine}});
 await started;
 const r=await jobs.enqueue(db,{kind:'fixture.routine',idempotencyKey:'routine'});
 let state;for(const end=Date.now()+5000;Date.now()<end;){state=await jobs.get(db,r.job.id,null);if(state.status==='COMPLETED')break;await new Promise(resolve=>setTimeout(resolve,20));}
 assert.equal(state.status,'COMPLETED');assert.equal((await jobs.get(db,b.job.id,null)).status,'RUNNING');
 assert.deepEqual(calls,{bulk:1,routine:1});
 release();for(const end=Date.now()+5000;Date.now()<end;){state=await jobs.get(db,b.job.id,null);if(state.status==='COMPLETED')break;await new Promise(resolve=>setTimeout(resolve,20));}
 assert.equal(state.status,'COMPLETED');await worker.stop();assert.deepEqual(calls,{bulk:1,routine:1});
 const unrelated=await jobs.enqueue(db,{kind:'fixture.unrelated',idempotencyKey:'not-requested',priority:0}),requested=await jobs.enqueue(db,{kind:'fixture.requested',idempotencyKey:'requested',priority:90});
 const unexpected=async()=>{throw new Error('An unrequested job must stay pending');},selected=async()=>({selected:true});unexpected.externalEffect=selected.externalEffect=true;
 const picked=await jobs.processOne(db,{'fixture.unrelated':unexpected,'fixture.requested':selected},{owner:'explicit-kind-selection',kinds:['fixture.requested']});assert.equal(picked.id,requested.job.id);assert.equal(picked.status,'COMPLETED');assert.equal((await jobs.get(db,unrelated.job.id,null)).status,'PENDING');
 assert.equal(await jobs.processOne(db,{'fixture.unrelated':unexpected},{owner:'empty-kind-selection',kinds:[]}),null);assert.equal((await jobs.get(db,unrelated.job.id,null)).status,'PENDING');
});
