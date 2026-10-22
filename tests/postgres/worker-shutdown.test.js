'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('retiring workers finish active work but never claim another job while a different runtime drains',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);await require('../../src/db/migrate-postgres').migratePostgres(db);
 const jobs=require('../../src/operations/postgres-job-queue');let releaseActive,activeStarted,releaseTelemetry,worker,calls=0,stopped=false;
 const held=new Promise(r=>releaseActive=r),started=new Promise(r=>activeStarted=r),telemetry=new Promise(r=>releaseTelemetry=r);
 t.after(async()=>{releaseActive();releaseTelemetry();if(worker)await worker.stop();await db.close();await cluster.stop();});
 const handler=async()=>{calls++;activeStarted();await held;return {verified:true};};handler.externalEffect=true;
 const first=await jobs.enqueue(db,{kind:'fixture.drain',idempotencyKey:'first'});worker=require('../../src/operations/postgres-worker').start(db,{owner:'retiring-worker',handlers:{'fixture.drain':handler},intervalMs:10});await started;
 const second=await jobs.enqueue(db,{kind:'fixture.drain',idempotencyKey:'second'});
 // Put the slow runtime first: sequential shutdown would wait for it and
 // leave the worker free to claim the second job as the first one finishes.
 const stopping=require('../../src/operations/runtime-shutdown').stopRuntimes([{stop:()=>telemetry},worker]).then(()=>{stopped=true;});
 releaseActive();for(const until=Date.now()+5000;Date.now()<until;){if((await jobs.get(db,first.job.id,null)).status==='COMPLETED')break;await new Promise(r=>setTimeout(r,20));}
 assert.equal((await jobs.get(db,first.job.id,null)).status,'COMPLETED');worker.wake();await new Promise(r=>setTimeout(r,100));assert.equal(calls,1);assert.equal((await jobs.get(db,second.job.id,null)).status,'PENDING');assert.equal(stopped,false);
 releaseTelemetry();await stopping;assert.equal(stopped,true);
 const completed=await jobs.processOne(db,{'fixture.drain':handler},{owner:'replacement-worker'});assert.equal(completed.id,second.job.id);assert.equal(completed.status,'COMPLETED');assert.equal(calls,2);
 t.diagnostic(JSON.stringify({actualPostgreSQL:true,activeJobCompleted:true,noRetiringWorkerClaims:true,replacementCompletedOnce:true,paidCalls:0}));
});
