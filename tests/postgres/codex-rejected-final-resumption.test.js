'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('an explicitly resumed rejected native final returns typed feedback to the same actual SDK thread without resetting its budget',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','FOUNDRY_DATABASE_URL'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(async()=>{for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;await db.close();cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Native repair owner',businessName:'Testing',email,password:'Offline!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:'Testing',emails:[email]})).environment);process.env.FOUNDRY_DATABASE_URL=cluster.connectionString;
 await db.query("UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=500000,approval_reference='OFFLINE FAKE PROVIDER ONLY' WHERE workspace_id=$1",[ctx.workspaceId]);
 await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);
 const pilot=require('../../src/assistant/postgres-codex-pilot'),store=require('../../src/assistant/postgres-goal-store'),request='Tell me this business name, without changing anything.';
 const started=await pilot.start(db,ctx,request);let calls=0;
 const fake=async(_url,init)=>{calls++;const body=JSON.parse(init.body),goal=await store.get(db,ctx,started.goalId),entry=Object.values(goal.checkpoint.harness.evidence).findLast(e=>e.name==='authorized_environment');assert(entry);
  if(calls>=2){assert(JSON.stringify(body).includes('host_verification_feedback'));assert(JSON.stringify(body).includes('EVIDENCE_POINTER_NOT_FOUND'));assert(JSON.stringify(body).includes(request));}
  return require('../helpers/codex-offline-response').final(body,calls,JSON.stringify({version:1,status:'completed',outcome:'answer',answer:'The business is Testing.',claims:[{evidenceId:entry.id,path:calls<=2?'/business/not_a_field':'/business/name',value:'Testing'}]}));};
 const options={image:process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE,apiKey:'FAKE',fetchImpl:fake,countInput:async()=>({object:'response.input_tokens',input_tokens:200})};assert(options.image);
 await pilot.run(db,ctx,started.goalId,options);const failed=await store.get(db,ctx,started.goalId);
 assert.equal(failed.status,'BLOCKED');assert.equal(calls,2,'Only one bounded native report correction; a second rejection stops');assert.equal(failed.checkpoint.harness.verificationCorrections,1);assert.equal(failed.checkpoint.harness.verificationFailure.code,'EVIDENCE_POINTER_NOT_FOUND');assert.equal(failed.checkpoint.harness.failure.requiresUserInput,false);
 const originalThread=failed.checkpoint.harness.native.codex.threadId,originalBudget=failed.budget_minor;
 await db.query('UPDATE stockchief_runtime.codex_pilots SET stopped=true WHERE workspace_id=$1',[ctx.workspaceId]);await assert.rejects(pilot.resume(db,ctx,started.goalId));assert.equal(calls,2,'A paused allowance cannot be bypassed to repair a model result');
 await db.query('UPDATE stockchief_runtime.codex_pilots SET stopped=false WHERE workspace_id=$1',[ctx.workspaceId]);
 await pilot.resume(db,ctx,started.goalId);await pilot.run(db,ctx,started.goalId,options);const done=await store.get(db,ctx,started.goalId);
 assert.equal(done.status,'COMPLETED',JSON.stringify({answer:done.answer,failure:done.checkpoint.harness.failure,verification:done.checkpoint.harness.verificationFailure}));assert.equal(calls,3);assert.equal(done.budget_minor,originalBudget);assert.equal(done.original_request,request);
 assert.equal(done.checkpoint.harness.native.codex.threadId,originalThread);assert.equal(done.checkpoint.harness.codexRequests,3,'The goal counter continues; it is not a fresh attempt or top-up');assert.equal(done.checkpoint.harness.verificationCorrections,1);assert.equal(done.checkpoint.harness.verificationFailure,null);
 assert.equal((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
});
