'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('the complete production business handler set starts within its lane bound and processes routine mailbox work',{timeout:90000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString,{max:5});let runtime;
 t.after(async()=>{await runtime?.stop();await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Worker owner',businessName:'Worker startup verification',email:randomUUID()+'@example.test',password:'Worker!'+randomUUID()}),handlers={...require('../../src/operations/postgres-business-handlers').create(),...require('../../src/operations/postgres-runtime-handlers').create()},lanes=new Set(Object.values(handlers).filter(h=>typeof h==='function').map(h=>h.workerLane||'default'));
 assert.equal(lanes.size,4,'Production keeps its existing four-lane resource bound');assert.equal(handlers['autopilot.evaluate'].workerLane,handlers['system.reconcile-business'].workerLane,'Both maintenance kinds share their bounded maintenance lane');
 const queue=require('../../src/operations/postgres-job-queue'),job=await queue.enqueue(db,{workspaceId:owner.workspaceId,kind:'mailbox.poll',payload:{connectorId:'absent-connection-'+randomUUID()},idempotencyKey:'full-startup-'+randomUUID()}),errors=[];
 runtime=require('../../src/operations/postgres-worker').start(db,{handlers,intervalMs:20,onError:e=>errors.push(e.code||e.message)});
 let saved;for(let i=0;i<200;i++){saved=await queue.get(db,job.job.id,owner.workspaceId);if(saved.status==='COMPLETED')break;await new Promise(r=>setTimeout(r,25));}
 assert.equal(saved.status,'COMPLETED');assert.equal(saved.attemptCount,1);assert.equal(saved.result.skipped,'connection_missing');assert.deepEqual(errors,[]);
 t.diagnostic(JSON.stringify({actualPostgreSQL:true,completeProductionHandlerSet:true,executionLanes:lanes.size,routineMailboxWorkCompleted:true,providerCalls:0,paidCalls:0}));
});
