'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('a held Ask goal cannot block another inventory and the same inventory retains one active job',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,auth=require('../../src/domain/postgres-auth-service'),jobs=require('../../src/operations/postgres-job-queue');
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,source) VALUES('ask-parallel',$1,'pro','COMP','ISOLATED_TEST')",[f.owner.accountId]);
 const other=await auth.createWorkspace(db,f.owner.accountId,{name:'Independent Ask inventory'}),kind='assistant.run-codex-goal',first=await jobs.enqueue(db,{workspaceId:ctx.workspaceId,kind,idempotencyKey:'ask-held',payload:{name:'held'}}),second=await jobs.enqueue(db,{workspaceId:ctx.workspaceId,kind,idempotencyKey:'ask-next',payload:{name:'next'}}),foreign=await jobs.enqueue(db,{workspaceId:other.workspaceId,kind,idempotencyKey:'ask-independent',payload:{name:'independent'}});
 let release,started,worker;const hold=new Promise(r=>release=r),entered=new Promise(r=>started=r),calls=[];
 t.after(async()=>{release();await worker?.stop();});
 const handler=async job=>{calls.push(job.payload.name);if(job.id===first.job.id){started();await hold;}return {verified:true};};handler.externalEffect=true;
 worker=require('../../src/operations/postgres-worker').start(db,{owner:'ask-parallel-qualification',concurrency:2,intervalMs:20,leaseMs:60000,handlers:{[kind]:handler}});
 await entered;let state;const start=performance.now();for(const end=Date.now()+2000;Date.now()<end;){state=await jobs.get(db,foreign.job.id,other.workspaceId);if(state.status==='COMPLETED')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(state.status,'COMPLETED','An unrelated inventory must finish while the first goal is held');assert(performance.now()-start<2000);assert.equal((await jobs.get(db,first.job.id,ctx.workspaceId)).status,'RUNNING');assert.equal((await jobs.get(db,second.job.id,ctx.workspaceId)).status,'PENDING');assert.deepEqual(calls,['held','independent']);
 assert.equal(await jobs.claim(db,{owner:'independent-claim-probe',kinds:[kind]}),null,'Independent worker processes cannot bypass the inventory lane');
 const timing=(await db.query("SELECT detail FROM stockchief_runtime.job_events WHERE job_id=$1 AND event_type='CLAIMED'",[foreign.job.id])).rows[0].detail;
 assert(Number.isFinite(timing.queueWaitMs)&&timing.queueWaitMs>=0&&timing.queueWaitMs<2000,'Every claim records its independent queue wait');
 release();worker.wake();for(const end=Date.now()+2000;Date.now()<end;){state=await jobs.get(db,second.job.id,ctx.workspaceId);if(state.status==='COMPLETED')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(state.status,'COMPLETED');await worker.stop();assert.deepEqual(calls,['held','independent','next']);
});
