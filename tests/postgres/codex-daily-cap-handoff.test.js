'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('recorded daily-cap stop retains its typed reason and evidence, blocks upstream spending, and resumes the same SDK goal after an authorized capacity change',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','FOUNDRY_DATABASE_URL','STOCKCHIEF_AI_MAX_MODEL_ATTEMPTS_PER_DAY','STOCKCHIEF_CODEX_MODEL_POLICY'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(async()=>{for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Reviewer',businessName:'Daily-cap fixture',email,password:'Offline!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:'Daily-cap fixture',emails:[email]})).environment);
 process.env.FOUNDRY_DATABASE_URL=cluster.connectionString;process.env.STOCKCHIEF_AI_MAX_MODEL_ATTEMPTS_PER_DAY='1';process.env.STOCKCHIEF_CODEX_MODEL_POLICY=JSON.stringify({default:{initialTier:'fast',profiles:{fast:'sol-low'}}});
 await db.query("UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=1000000,approval_reference='OFFLINE ONLY' WHERE workspace_id=$1",[ctx.workspaceId]);await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);
 const pilot=require('../../src/assistant/postgres-codex-pilot'),store=require('../../src/assistant/postgres-goal-store'),conversation=require('../../src/assistant/agent-conversation');
 const response=await pilot.start(db,ctx,'Read only: how many active products exist?');let calls=0;
 const fake=async(_url,init)=>{const body=JSON.parse(init.body);calls++;
  if(calls===1)return require('../helpers/codex-offline-response')(body,calls,
   `text(await tools.mcp__stockchief__business_operations({stepsJson:JSON.stringify([{capability:'read.inventory_summary',arguments:[],dependsOn:[]}])}));`);
  assert.equal(calls,2,'The blocked admission cannot contact the provider and resumption needs one final response');
  const goal=await store.get(db,ctx,response.goalId),entry=Object.values(goal.checkpoint.harness.evidence).find(e=>e.name==='business_operations'),value=JSON.parse(entry.text).outcomes[0].result.rows[0].products;
  return require('../helpers/codex-offline-response').final(body,calls,JSON.stringify({status:'completed',outcome:'answer',answer:'There are '+value+' active products.',claims:[{evidenceId:entry.id,path:'/outcomes/0/result/rows/0/products',value}]}));
 };
 const options={image:process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE,apiKey:'FAKE',fetchImpl:fake,countInput:async()=>({object:'response.input_tokens',input_tokens:200})};assert(options.image);
 await pilot.run(db,ctx,response.goalId,options);const stopped=await store.get(db,ctx,response.goalId);
 assert.equal(calls,1);assert.equal(stopped.status,'BLOCKED');assert.equal(stopped.checkpoint.harness.interruption.limitKind,'daily_model_attempts');assert.equal(conversation.state(stopped).phase,'capacity');
 assert.equal(conversation.state(stopped).canReply,false);assert.equal(conversation.state(stopped).terminal,false);assert.match(conversation.state(stopped).message,/daily allowance resets/);
 assert.deepEqual(conversation.state(await store.progress(db,ctx,response.goalId)),conversation.state(stopped));
 const evidenceIds=Object.keys(stopped.checkpoint.harness.evidence),thread=stopped.checkpoint.harness.native.codex.threadId;
 const ledger=(await db.query('SELECT state,charged,detail FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1 AND goal_id=$2 ORDER BY created_at',[ctx.workspaceId,response.goalId])).rows;
 assert.equal(ledger.length,2);assert.equal(ledger[1].state,'SETTLED');assert.equal(Number(ledger[1].charged),0);assert.equal(ledger[1].detail.upstreamAttempted,false);
 assert.equal(Number((await db.query('SELECT attempts FROM commercial_model_daily_attempts WHERE account_id=$1',[owner.accountId])).rows[0].attempts),1);
 // Local fixture represents explicit operator authorization. The runtime does
 // not change this limit, reset the counter, replace the thread or refill money.
 process.env.STOCKCHIEF_AI_MAX_MODEL_ATTEMPTS_PER_DAY='2';await pilot.resume(db,ctx,response.goalId);await pilot.run(db,ctx,response.goalId,options);
 const completed=await store.get(db,ctx,response.goalId);assert.equal(completed.status,'COMPLETED');assert.equal(calls,2);assert.equal(completed.id,stopped.id);assert.equal(completed.checkpoint.harness.native.codex.threadId,thread);
 assert(evidenceIds.every(id=>completed.checkpoint.harness.evidence[id]));assert.equal(Number(completed.budget_minor),100);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0);
 t.diagnostic(JSON.stringify({providerCalls:2,blockedUpstreamCalls:0,sameNativeThread:true,counterNotReset:true,noBusinessEffects:true}));
});
