'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{randomUUID}=require('node:crypto');
const base='../../scripts/environment-agent-demo/',goals=require('../../src/assistant/postgres-goal-store'),wire=require(base+'codex-wire');
test('native admission, delivery, termination and accounting reject safely without paid calls',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 const cleanup=[];t.after(async()=>{for(const close of cleanup.reverse())await close();await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Offline boundary audit',businessName:'Native lifecycle audit',email:randomUUID()+'@example.test',password:'Offline!'+randomUUID()});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 for(const [operation,dollars]of Object.entries(wire.PROFILE.rates))await db.query(`INSERT INTO commercial_cost_rates(id,provider,model,provider_version,operation,unit,cost_per_unit_minor,currency,effective_from,source,pricing_basis,confidence)
  VALUES($1,'openai',$2,'responses-2026-10-11',$3,'token',$4,'USD',now(),$5,'VERIFIED_PUBLIC','HIGH')`,['boundary-'+operation,wire.MODEL,operation,dollars/10000,wire.source]);
 const ent=require('../../src/commercial/entitlements'),scope=await ent.ownerScopeForWorkspace(db,ctx.workspaceId);
 await ent.reserveUsage(db,scope,{meter:'ai_work_credits',units:1,idempotencyKey:ctx.workspaceId+':fake'});
 const budget=new(require(base+'budget').ExperimentBudget)(path.join(cluster.directory,'audit-budget.sqlite'),'OFFLINE NATIVE BOUNDARIES');cleanup.push(()=>budget.close());
 budget.approve({ceilingMicroUsd:1000000,approvalReference:'FAKE RESPONSES ONLY',expiresAt:new Date(Date.now()+120000).toISOString()});
 let providerCalls=0,counterCalls=0,count=10000,empty=false,unknown=false;
 const relay=await require(base+'relay').createRelay({budget,credentials:{openai:'FAKE'},commercial:require(base+'commercial').createCommercialAccounting(db),
  countCodexInput:async()=>{counterCalls++;return {object:'response.input_tokens',input_tokens:count};},
  fetchImpl:async(_url,init)=>{providerCalls++;if(unknown)throw Error('OFFLINE_LOST_RESPONSE');
   const body=JSON.parse(init.body);return Response.json({object:'response',id:'offline-boundary-'+providerCalls,model:body.model,status:'completed',
    output:empty?[]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Observed current records.'}]}],
    usage:{input_tokens:200,output_tokens:empty?0:10}});}});cleanup.push(()=>relay.close());
 async function attach(verifier){const goal=await goals.claim(db,ctx,(await goals.create(db,ctx,'Investigate current records.',{budgetMinor:75})).id);
  const gateway=require(base+'gateway').createGateway({database:db,ctx,goal:goal.original_request,goalId:goal.id,runToken:goal.run_token,provider:{complete:async()=>{throw Error('PAID_MODEL_FORBIDDEN');}}});
  const session=require(base+'session').createSession({database:db,ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex',authorize:gateway.authorize,verifyOutcome:verifier});
  const transport=relay.grant({candidate:'codex',provider:'openai',task:goal.id,ctx,goalId:goal.id,fundingKey:'fake',authorize:gateway.authorize,wireProfile:'codex',requestGate:()=>session.codexRequest()});
  transport.setNativeSession(session);return {goal,gateway,session,transport};}
 const request={model:wire.MODEL,reasoning:{effort:wire.EFFORT},input:[{role:'user',content:'Investigate current records.'}]};
 const call=(x,body=request)=>fetch(x.transport.openaiBaseURL+'/responses',{method:'POST',headers:{authorization:`Bearer ${x.transport.token}`,'content-type':'application/json'},body:JSON.stringify(body)});
 await t.test('legacy overrides and cross-tenant session binding cannot enter the native path',async()=>{
  const x=await attach();assert.throws(()=>x.transport.setControlSource(()=>({final:true})),/OWNED_BY_SDK/);assert.throws(()=>x.transport.setContextSource(()=>({})),/OWNED_BY_SDK/);
  assert.throws(()=>x.transport.setNativeSession({...x.session,identity:{...x.session.identity,workspaceId:'foreign'}}),/INVALID_CODEX_SESSION/);
  assert.equal((await call(x,{...request,max_output_tokens:3001})).status,403);assert.equal(counterCalls,0);assert.equal(providerCalls,0);
 });
 await t.test('native empty output is settled and delivered unchanged; restart replays it without buying another response',async()=>{
  const x=await attach();empty=true;assert.equal((await call(x)).status,200);assert.equal(x.transport.lastResponse().empty,true);
  const before=[providerCalls,counterCalls,budget.status().committed];
  const renewed=require(base+'session').createSession({database:db,ctx,goalId:x.goal.id,runToken:x.goal.run_token,candidate:'codex',authorize:x.gateway.authorize});x.transport.setNativeSession(renewed);
  assert.equal((await call(x)).status,200);assert.deepEqual([providerCalls,counterCalls,budget.status().committed],before);
  assert.equal((await call(x,{...request,input:[...request.input,{role:'user',content:'Continue within the same authorized budget.'}]})).status,200);
  assert.equal(providerCalls,before[0]+1,'native continuation remains subject to all financial holds');empty=false;
 });
 await t.test('native token ceiling rejects before generation; unresolved delivery rejects before another count',async()=>{
  let x=await attach();const before=providerCalls;count=108001;assert.equal((await call(x)).status,400);assert.equal(x.transport.lastBlock().code,'CODEX_REQUEST_COST_CEILING');assert.equal(providerCalls,before);count=10000;
  x=await attach();await x.session.codexPending('unacknowledged-provider-response');const beforeCount=counterCalls;
  assert.equal((await call(x)).status,403);assert.equal(x.transport.lastBlock().code,'CODEX_RESPONSE_RECONCILIATION_REQUIRED');assert.equal(counterCalls,beforeCount);assert.equal(providerCalls,before);
 });
 await t.test('an exhausted tool allowance cannot become WAITING_USER',async()=>{
  const x=await attach();await db.query('UPDATE stockchief_runtime.assistant_goals SET tool_calls=30 WHERE id=$1',[x.goal.id]);
  await assert.rejects(()=>x.session.execute('environment_browser',{action:'inspect'},async()=>({})),/DURABLE_TOOL_LIMIT/);
  await x.session.finish({answer:JSON.stringify({status:'needs_user',question:'Allow me to continue?',missingInformation:'More tool calls'})});
  const g=await goals.get(db,ctx,x.goal.id);assert.equal(g.status,'BLOCKED');assert.equal(g.checkpoint.harness.failure.code,'DURABLE_TOOL_LIMIT');
 });
 await t.test('expired-lease cleanup records the precise stop and cannot overwrite cancellation',async()=>{
  let x=await attach();await db.query("UPDATE stockchief_runtime.assistant_goals SET lease_until=now()-interval '1 second' WHERE id=$1",[x.goal.id]);
  assert.equal((await x.session.stop({code:'CODEX_RUNTIME_TIMEOUT'})).status,'BLOCKED');assert.equal((await goals.get(db,ctx,x.goal.id)).checkpoint.harness.interruption.code,'CODEX_RUNTIME_TIMEOUT');
  x=await attach();await goals.cancel(db,ctx,x.goal.id);await x.session.stop({code:'CODEX_RUNTIME_TIMEOUT'});assert.equal((await goals.get(db,ctx,x.goal.id)).status,'CANCELLED');
 });
 await t.test('a failed PostgreSQL verifier cannot claim completion or trigger a provider request',async()=>{
  let verifications=0;const x=await attach(async client=>{verifications++;await client.query('SELECT definitely_missing_column FROM workspaces');});
  const before=providerCalls;const result=await require(base+'worker').run({...x,candidate:'codex',budget});
  assert.equal(result.interruption.code,'WHOLE_GOAL_VERIFICATION_FAILED');assert.equal(verifications,1);assert.equal(providerCalls,before);assert.equal(result.status,'BLOCKED');
 });
 await t.test('unknown provider outcome retains both reservations and prevents another count or generation',async()=>{
  const x=await attach();unknown=true;assert.equal((await call(x)).status,403);
  const exposure=budget.status().committed,before=[providerCalls,counterCalls];assert.equal(budget.status().unresolved,1);
  assert.equal((await call(x)).status,403);assert.deepEqual([providerCalls,counterCalls],before);assert.equal(budget.status().committed,exposure);
  assert.equal((await db.query('SELECT status FROM commercial_model_cost_holds WHERE goal_id=$1',[x.goal.id])).rows[0].status,'UNKNOWN');
 });
});
