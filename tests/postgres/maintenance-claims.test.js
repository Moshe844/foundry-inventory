'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict');
test('independent workers cannot run planning and reconciliation for the same business at once; other businesses stay independent',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,q=require('../../src/operations/postgres-job-queue');await q.enqueue(db,{workspaceId:ctx.workspaceId,kind:'autopilot.evaluate',idempotencyKey:'claim-a',payload:{actorId:ctx.actorId},priority:40});await q.enqueue(db,{workspaceId:ctx.workspaceId,kind:'system.reconcile-business',idempotencyKey:'claim-b',payload:{},priority:80});const a=await Promise.all([q.claim(db,{owner:'planner',kinds:['autopilot.evaluate']}),q.claim(db,{owner:'reconciler',kinds:['system.reconcile-business']})]);assert.equal(a.filter(Boolean).length,1,'Both maintenance kinds claimed the same business');const other=await require('../../src/domain/postgres-auth-service').createWorkspace(db,f.owner.accountId,{name:'Independent queue business'});await q.enqueue(db,{workspaceId:other.workspaceId,kind:'system.reconcile-business',idempotencyKey:'claim-other',payload:{}});assert.equal((await q.claim(db,{owner:'other-business',kinds:['system.reconcile-business']})).workspaceId,other.workspaceId);assert.equal(await f.balance(),4);
});
test('planning continuations cannot starve older reconciliation; ordinary queue priorities remain intact',{timeout:120000},async t=>{
 const {db,ctx}=await require('../helpers/postgres-shipping-fixture').fixture(t),q=require('../../src/operations/postgres-job-queue'),now=Date.now();
 const old=await q.enqueue(db,{workspaceId:ctx.workspaceId,kind:'system.reconcile-business',idempotencyKey:'old-reconciliation',priority:80,now:now-600000});
 const plan=await q.enqueue(db,{workspaceId:ctx.workspaceId,kind:'autopilot.evaluate',idempotencyKey:'new-planning-page',priority:39,now:now-1000});
 const first=await q.claim(db,{owner:'maintenance-fairness',kinds:q.MAINTENANCE_KINDS});
 assert.equal(first.id,old.job.id);await q.complete(db,first.id,first.leaseToken,{verified:true});
 await q.enqueue(db,{workspaceId:ctx.workspaceId,kind:'system.reconcile-business',idempotencyKey:'next-reconciliation-page',priority:79});
 const second=await q.claim(db,{owner:'maintenance-fairness',kinds:q.MAINTENANCE_KINDS});
 assert.equal(second.id,plan.job.id);await q.complete(db,second.id,second.leaseToken,{verified:true});
 const low=await q.enqueue(db,{kind:'fixture.ordinary',idempotencyKey:'low-priority',priority:80,now:now-600000});
 const high=await q.enqueue(db,{kind:'fixture.ordinary',idempotencyKey:'high-priority',priority:10});
 assert.equal((await q.claim(db,{owner:'ordinary-priority',kinds:['fixture.ordinary']})).id,high.job.id);
 assert.equal((await q.get(db,low.job.id,null)).status,'PENDING');
});
