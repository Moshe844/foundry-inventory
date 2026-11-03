'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('hosted read agents answer separate inventories in parallel without Docker or a browser',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,owner}=f;
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','STOCKCHIEF_CODEX_PILOT_ACCOUNT_ACCESS','STOCKCHIEF_CODEX_MODEL_POLICY','STOCKCHIEF_AI_METER'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];});
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source) VALUES($1,$2,'pro','COMP','CUSTOM','OFFLINE_FIXTURE')",[randomUUID(),owner.accountId]);
 const other=await require('../../src/domain/postgres-auth-service').createWorkspace(db,owner.accountId,{name:'Other hosted-read inventory'}),otherCtx={workspaceId:other.workspaceId,actorId:other.userId};
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';process.env.STOCKCHIEF_AI_METER='credits';
 process.env.STOCKCHIEF_CODEX_MODEL_POLICY=JSON.stringify({default:{initialTier:'fast',profiles:{fast:'sol-low'}}});
 const provision=require('../../scripts/provision-codex-staging');Object.assign(process.env,(await provision.provision(db,{businessName:'Shipping operation fixture',emails:[f.email]})).environment);
 await db.query("UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=1000000,approval_reference='OFFLINE ONLY' WHERE workspace_id=$1",[ctx.workspaceId]);
 await provision.shareWithOwnedBusinesses(db,{fundingWorkspaceId:ctx.workspaceId,accountId:owner.accountId});process.env.STOCKCHIEF_CODEX_PILOT_ACCOUNT_ACCESS='1';
 await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);
 const pilot=require('../../src/assistant/postgres-codex-pilot'),store=require('../../src/assistant/postgres-goal-store');
 const first=await pilot.start(db,ctx,'How many catalogue SKUs are there?'),second=await pilot.start(db,otherCtx,'How many catalogue SKUs are there?');
 const queued=(await db.query("SELECT kind FROM stockchief_runtime.jobs WHERE payload->>'goalId'=ANY($1::text[])",[[first.goalId,second.goalId]])).rows;
 assert.equal(queued.length,2);assert(queued.every(row=>row.kind==='assistant.run-codex-read'));
 let calls=0,started,unblock;const entered=new Promise(r=>started=r),release=new Promise(r=>unblock=r),errors=[];
 const runtime=await require('../../src/assistant/postgres-hosted-read-worker').start(db,{concurrency:2,intervalMs:20,onError:e=>errors.push(e),runtime:{
  image:'database-tools-v1',apiKey:'FAKE',countInput:async()=>({object:'response.input_tokens',input_tokens:200}),
  sandboxPool:{take:()=>{throw Error('READ_ONLY_SANDBOX_FORBIDDEN');}},inspectionPool:{acquire:()=>{throw Error('READ_ONLY_BROWSER_FORBIDDEN');}},
  fetchImpl:async(url,init)=>{
   assert.equal(url,'https://api.openai.com/v1/responses');const n=++calls;if(n===1){started();await release;}
   const body=JSON.parse(init.body);return Response.json({id:'offline_hosted_'+n,object:'response',model:body.model,status:'completed',service_tier:'default',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({status:'read',question:'',queries:[{dataset:'catalogue',summary:true,aggregate:'count'}]})}]}],usage:{input_tokens:200,output_tokens:40,input_tokens_details:{cached_tokens:0}}});
  }} });
 f.cleanup(async()=>{unblock();await runtime.stop();});
 const wait=async read=>{for(const end=Date.now()+10000;Date.now()<end;){if(await read())return;await new Promise(r=>setTimeout(r,20));}assert.fail('Hosted read did not progress; '+errors.map(e=>e.code||e.message).join(', '));};
 await Promise.race([entered,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('HOSTED_READ_DID_NOT_START')),10000);timer.unref();})]);
 await wait(async()=>calls===2);assert.equal(calls,2,'Another inventory reaches the provider while the first request is held');
 await wait(async()=>{const goals=await Promise.all([store.get(db,ctx,first.goalId),store.get(db,otherCtx,second.goalId)]);return goals.some(g=>g.status==='COMPLETED');});
 assert.equal((await store.progress(db,ctx,first.goalId)).worker_available,true);
 unblock();await wait(async()=>{const goals=await Promise.all([store.get(db,ctx,first.goalId),store.get(db,otherCtx,second.goalId)]);return goals.every(g=>g.status==='COMPLETED');});
 assert.deepEqual(errors,[]);assert.equal(calls,2);await runtime.stop();
 assert.equal((await store.progress(db,ctx,first.goalId)).worker_available,false);
 const jobs=(await db.query("SELECT result FROM stockchief_runtime.jobs WHERE payload->>'goalId'=ANY($1::text[])",[[first.goalId,second.goalId]])).rows;
 assert(jobs.every(j=>!j.result.checkpoint&&!j.result.answer),'Job receipts do not duplicate the full goal and evidence ledger');
 await t.test('the hosted lane cannot bypass the account agent-job allowance',async()=>{
  const queue=require('../../src/operations/postgres-job-queue');
  await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,'agent_jobs',1,'OFFLINE hosted lane boundary')",[randomUUID(),owner.accountId]);
  for(const [index,scope]of [ctx,otherCtx].entries())await queue.enqueue(db,{workspaceId:scope.workspaceId,kind:'assistant.run-codex-read',idempotencyKey:'hosted-plan-boundary-'+index,payload:{goalId:'offline-boundary-'+index,actorId:scope.actorId}});
  const a=await queue.claim(db,{owner:'hosted-plan-test',kinds:['assistant.run-codex-read']});assert(a);
  assert.equal(await queue.claim(db,{owner:'second-hosted-plan-test',kinds:['assistant.run-codex-read']}),null);
  const meter=await require('../../src/commercial/entitlements').meterState(db,{accountId:owner.accountId,workspaceId:ctx.workspaceId},'agent_jobs');assert.equal(meter.used,1);assert.equal(meter.hardLimit,1);
  await queue.complete(db,a.id,a.leaseToken,{});const b=await queue.claim(db,{owner:'second-hosted-plan-test',kinds:['assistant.run-codex-read']});assert(b);await queue.complete(db,b.id,b.leaseToken,{});
 });
 t.diagnostic(JSON.stringify({providerCalls:2,parallelInventories:2,browsers:0,sandboxes:0,paidCalls:0}));
});
