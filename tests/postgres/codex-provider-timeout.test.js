'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('actual pinned SDK preserves the recorded two responses then unknown third-call boundary without repeating spend or business effects',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','FOUNDRY_DATABASE_URL','STOCKCHIEF_CODEX_MODEL_POLICY'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(async()=>{for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Reviewer',businessName:'Unknown usage fixture',email,password:'Offline!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:'Unknown usage fixture',emails:[email]})).environment);
 process.env.FOUNDRY_DATABASE_URL=cluster.connectionString;process.env.STOCKCHIEF_CODEX_MODEL_POLICY=JSON.stringify({default:{initialTier:'fast',profiles:{fast:'sol-low-fast'}}});
 await db.query("UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=1000000,approval_reference='OFFLINE ONLY' WHERE workspace_id=$1",[ctx.workspaceId]);await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);
 const profile=require('../../scripts/environment-agent-demo/codex-models').getProfile('sol-low-fast');
 for(const [operation,rate]of Object.entries(profile.rates))await db.query(`INSERT INTO commercial_cost_rates(id,provider,model,provider_version,operation,unit,cost_per_unit_minor,currency,effective_from,source,pricing_basis,confidence)
  VALUES($1,'openai',$2,$3,$4,'token',$5,'USD',now(),'OFFLINE SYNTHETIC PROVIDER ONLY','VERIFIED_PUBLIC','HIGH')`,[randomUUID(),profile.model,profile.providerVersion,operation,rate/10000]);
 const pilot=require('../../src/assistant/postgres-codex-pilot'),store=require('../../src/assistant/postgres-goal-store'),conversation=require('../../src/assistant/agent-conversation');
 const started=await pilot.start(db,ctx,'Investigate the authorized inventory and inspect the application without changing records.');let calls=0;
 const options={image:process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE,apiKey:'FAKE',countInput:async()=>({object:'response.input_tokens',input_tokens:200}),fetchImpl:async(_url,init)=>{
  calls++;assert.equal(typeof init.headers['x-client-request-id'],'string');const body=JSON.parse(init.body);
  if(calls<=2){const program=calls===1?`text(await tools.mcp__stockchief__business_operations({stepsJson:JSON.stringify([{capability:'read.inventory_summary',arguments:[],dependsOn:[]}])}));`:`text(await tools.mcp__stockchief__environment_browser({action:'inspect',ref:null,value:null}));`;
   const response=require('../helpers/codex-offline-response')(body,calls,program);
   return new Response((await response.text()).replaceAll('"object":"response"','"object":"response","service_tier":"fast"'),{headers:{'content-type':'text/event-stream'}});
  }
  assert.equal(calls,3);throw new DOMException('The operation was aborted due to timeout','TimeoutError');
 }};assert(options.image);
 await pilot.run(db,ctx,started.goalId,options);const stopped=await store.get(db,ctx,started.goalId),h=stopped.checkpoint.harness,rows=(await db.query('SELECT id,state,reserved,charged,detail FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1 AND goal_id=$2 ORDER BY created_at',[ctx.workspaceId,stopped.id])).rows;
 if(calls!==3)t.diagnostic(JSON.stringify({status:stopped.status,answer:stopped.answer,interruption:h?.interruption,failure:h?.failure}));
 assert.equal(calls,3);assert.equal(rows.length,3);assert.equal(rows.filter(r=>r.state==='SETTLED').length,2);assert.equal(rows[2].state,'UNKNOWN');assert.equal(rows[2].charged,null);assert.equal(rows[2].detail.reason,'23');assert.equal(rows[2].detail.provider,'openai');assert.equal(rows[2].detail.model,'gpt-6.1-sol');assert.equal(rows[2].detail.transport.clientRequestId,rows[2].id);assert.equal(rows[2].detail.transport.phase,'request');
 assert.equal(stopped.status,'BLOCKED');assert.equal(h.codexDelivery.state,'PENDING');assert(h.native.codex.threadId);assert(Object.values(h.evidence).some(e=>e.name==='environment_browser'));assert(Object.values(h.evidence).some(e=>e.name==='business_operations'));assert.equal(conversation.state(stopped).phase,'usage_review');
 assert.equal(conversation.state(await store.progress(db,ctx,stopped.id)).phase,'usage_review');await assert.rejects(pilot.resume(db,ctx,stopped.id),/reconcil/i);assert.equal(calls,3,'Resumption must not repeat uncertain generation');
 const budget=require('../../src/assistant/postgres-codex-budget').createBudget(db,ctx,stopped.id),exposure=await budget.status();assert.equal(exposure.unresolved,1);assert.equal(exposure.committed,rows.reduce((sum,r)=>sum+Number(r.charged??r.reserved),0));await assert.rejects(budget.reserve({candidate:'codex',task:stopped.id,upperBoundMicroUsd:1}),/UNRESOLVED_MODEL_CALL/);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0);assert.equal(Number((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0);
 t.diagnostic(JSON.stringify({actualSdk:true,syntheticProvider:true,generations:3,settled:2,unknown:1,paidRetries:0,nativeEvidenceRetained:true,fullUnknownReservationRetained:true,businessEffects:0}));
});
