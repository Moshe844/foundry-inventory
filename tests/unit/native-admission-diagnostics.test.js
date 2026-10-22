'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const workerPath=require.resolve('../../scripts/environment-agent-demo/source-hash-worker');

test('source-integrity workers fail closed with bounded reasons and recover only with a new complete check',async t=>{
 const threads=require('node:worker_threads'),original=threads.Worker,workers=[];
 class FakeWorker extends EventEmitter{
  constructor(_file,options){super();this.ids=[];this.terminated=0;this.results=options.workerData.results;workers.push(this);}
  ref(){} unref(){} postMessage(id){this.ids.push(id);}
  reply(message){this.results.postMessage({finishedAt:process.hrtime.bigint(),...message});}
  terminate(){this.terminated++;this.results.close();return Promise.resolve(1);}
 }
 threads.Worker=FakeWorker;delete require.cache[workerPath];
 t.after(()=>{for(const worker of workers)worker.results.close();threads.Worker=original;delete require.cache[workerPath];});
 t.mock.timers.enable({apis:['setTimeout']});
 const module=require(workerPath),failed=kind=>error=>{assert.equal(error.code,'STAGING_CODEX_ADMISSION_BLOCKED');assert.equal(error.message,'STAGING_CODEX_ADMISSION_BLOCKED');assert.equal(error.limitKind,kind);return true;};
 const good='a'.repeat(64),first=module.sourceHash();workers[0].reply({id:workers[0].ids[0],hash:good});assert.equal(await first,good);
 const missing=module.sourceHash(),missingFailure=assert.rejects(missing,failed('source_integrity_read_enoent'));
 workers[0].reply({id:workers[0].ids.at(-1),error:true,kind:'source_integrity_read_enoent'});await missingFailure;
 const untrusted=module.sourceHash(),untrustedFailure=assert.rejects(untrusted,failed('source_integrity_invalid_result'));
 workers[0].reply({id:workers[0].ids.at(-1),error:true,kind:'/private/secret'});await untrustedFailure;
 const deliveredLate=module.sourceHash();workers[0].reply({id:workers[0].ids.at(-1),hash:good});
 t.mock.timers.tick(15000);assert.equal(await deliveredLate,good,'The deadline callback drains a timely result before treating parent delivery delay as worker failure');
 const computedLate=module.sourceHash(),lateFailure=assert.rejects(computedLate,failed('source_integrity_timeout'));
 workers[0].reply({id:workers[0].ids.at(-1),hash:good,finishedAt:process.hrtime.bigint()+16000000000n});await lateFailure;
 const timeoutA=module.sourceHash(),timeoutB=module.sourceHash(),timeouts=Promise.all([assert.rejects(timeoutA,failed('source_integrity_timeout')),assert.rejects(timeoutB,failed('source_integrity_timeout'))]);
 t.mock.timers.tick(15000);await timeouts;assert.equal(workers[0].terminated,1);
 const replacement=module.sourceHash();assert.equal(workers.length,2);workers[0].emit('exit',1);
 workers[1].reply({id:workers[1].ids[0],hash:'b'.repeat(64)});assert.equal(await replacement,'b'.repeat(64),'A dead worker cannot reject a new worker’s request');
 const crash=module.sourceHash(),crashed=assert.rejects(crash,failed('source_integrity_worker_error'));workers[1].emit('error',new Error('Sensitive runtime detail'));await crashed;
 const exit=module.sourceHash(),exited=assert.rejects(exit,failed('source_integrity_worker_exit'));workers[2].emit('exit',1);await exited;
});

test('native admission distinguishes stopped goals, spending holds, invalid binding and changed source without bypassing a guard',async t=>{
 const pilot=require('../../src/assistant/postgres-codex-pilot'),goals=require('../../src/assistant/postgres-goal-store'),source=require(workerPath),cert=require('../../scripts/environment-agent-demo/certification');
 const original={access:pilot.access,configured:pilot.configured,get:goals.get,hash:source.sourceHash,sync:cert.sourceHash};
 t.after(()=>{pilot.access=original.access;pilot.configured=original.configured;goals.get=original.get;source.sourceHash=original.hash;cert.sourceHash=original.sync;});
 let goal={status:'RUNNING',checkpoint:{runtime:'codex-staging'}},state={approval:'fixture',stopped:false,unresolved:0,expires:Date.now()+60000},hash='a'.repeat(64),checks=0;
 pilot.access=async()=>({});pilot.configured=()=>true;goals.get=async()=>goal;source.sourceHash=async()=>{checks++;return hash;};cert.sourceHash=()=>hash;
 const permit=require('../../src/assistant/codex-staging-permit'),budget={status:async()=>state},input={database:{},ctx:{workspaceId:'random-workspace',actorId:'random-actor'},goalId:'random-goal',budget,image:'sha256:'+'f'.repeat(64)};
 const failed=kind=>error=>{assert.equal(error.code,'STAGING_CODEX_ADMISSION_BLOCKED');assert.equal(error.limitKind,kind);return true;};
 goal.status='COMPLETED';await assert.rejects(permit.issue(input),failed('native_admission_goal_state'));goal.status='RUNNING';
 state.stopped=true;await assert.rejects(permit.issue(input),failed('native_admission_allowance'));state.stopped=false;
 state.unresolved=1;await assert.rejects(permit.issue(input),failed('native_admission_unsettled_usage'));state.unresolved=0;
 await assert.rejects(permit.issue({...input,image:'wrong'}),failed('native_admission_image'));assert.equal(checks,0,'Rejected admission cannot issue an integrity permit');
 const issued=await permit.issue(input);assert.equal(checks,1);await permit.assertFresh(issued,{budget,task:input.goalId});assert.equal(checks,2,'Every HTTP boundary still rechecks source');
 hash='c'.repeat(64);await assert.rejects(permit.assertFresh(issued,{budget}),failed('source_integrity_changed'));
 assert.throws(()=>permit.assert(issued,{budget}),failed('source_integrity_changed'));
 assert.throws(()=>permit.assertBinding(issued,{budget:{}}),failed('native_admission_binding'));
});
