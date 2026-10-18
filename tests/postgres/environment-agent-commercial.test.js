'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const goals=require('../../src/assistant/postgres-goal-store');
const usage=require('../../src/commercial/entitlements');
const costs=require('../../src/commercial/model-cost-budget');

test('native SDK cost holds require funded credit and obey durable goal, price and operation ceilings',async t=>{
 const cluster=await startCluster(),db=openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();cluster.stop();});await migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{
  name:'Native budget fixture',businessName:'Native budget fixture',email:`${randomUUID()}@example.test`,password:`Fixture!${randomUUID()}`});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId},scope=await usage.ownerScopeForWorkspace(db,ctx.workspaceId);
 const goal=await goals.create(db,ctx,'Investigate the fixture.',{budgetMinor:1});
 const held=await goals.claim(db,ctx,goal.id);
 const provider={name:'anthropic',model:'claude-haiku-4-5-20251001'};
 const bound={inputTokens:1000,outputTokens:100},goalScope={goalId:held.id,actorId:ctx.actorId};
 await assert.rejects(()=>costs.reserveNative(db,scope,provider,bound,'ask','missing-call','missing-funding',goalScope),/no funded Ask/);
 const funding=`${ctx.workspaceId}:fixture-funding`;
 await usage.reserveUsage(db,scope,{meter:'ai_work_credits',units:1,idempotencyKey:funding});
 await assert.rejects(()=>costs.reserveNative(db,scope,{name:'openai',model:'unpriced'},bound,'ask','unpriced',funding,goalScope),/verified price/);
 await assert.rejects(()=>costs.reserveNative(db,scope,provider,{inputTokens:1000000,outputTokens:3000},'ask','oversized',funding,goalScope),/per-operation/);
 let accepted=0;
 for(let i=0;i<20;i++){
  try{const hold=await costs.reserveNative(db,scope,provider,bound,'ask',`native-${i}`,funding,goalScope);
   assert.equal(hold.detail.providerExecutions,1);accepted++;
   // No receipt: these holds must continue consuming this goal's dollar budget.
   await costs.settle(db,scope,`native-${i}`,{failed:true});
  }catch(error){assert.match(error.message,/cumulative model-cost ceiling/);assert.equal(error.limitKind,'goal_cost');break;}
 }
 assert.ok(accepted>0&&accepted<20);
 const exposure=(await db.query(`SELECT sum(maximum_minor) AS amount,count(*)::int AS count FROM commercial_model_cost_holds WHERE goal_id=$1 AND status='UNKNOWN'`,[held.id])).rows[0];
 assert.ok(Number(exposure.amount)<=1);assert.equal(exposure.count,accepted);
 await goals.cancel(db,ctx,held.id);
 await assert.rejects(()=>costs.reserveNative(db,scope,provider,bound,'ask','cancelled',funding,goalScope),/no longer authorized/);
});

for(const provider of ['anthropic','openai'])test(`${provider} structured commercial wrapper crosses the shared relay once without a second hold`,async t=>{
 const path=require('node:path');
 const cluster=await startCluster(),db=openPostgres(cluster.connectionString);
 const cleanup=[];t.after(async()=>{for(const close of cleanup.reverse())await close();await db.close();cluster.stop();});await migratePostgres(db);
 await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{
  name:'Relay fixture',businessName:'Relay fixture',email:`${randomUUID()}@example.test`,password:`Fixture!${randomUUID()}`});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const goal=await goals.claim(db,ctx,(await goals.create(db,ctx,'Investigate fixture stock.')).id);
 const {ExperimentBudget}=require('../../scripts/environment-agent-demo/budget');
 const budget=new ExperimentBudget(path.join(cluster.directory,'offline-budget.sqlite'),'offline');
 budget.approve({ceilingMicroUsd:10000000,approvalReference:'FAKE PROVIDER ONLY',expiresAt:new Date(Date.now()+60000).toISOString()});
 let upstream=0;
 const relay=await require('../../scripts/environment-agent-demo/relay').createRelay({budget,
  credentials:{[provider]:'FAKE'},allowedProviders:[provider],commercial:require('../../scripts/environment-agent-demo/commercial').createCommercialAccounting(db),
  fetchImpl:async(_url,options)=>{upstream++;
   if(provider==='openai'){
    const body=JSON.parse(options.body);assert.equal(body.store,false);assert.equal(body.text.format.type,'json_schema');
    return Response.json({id:'resp_fixture',object:'response',status:'completed',
     output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'{"answer":"verified"}'}]}],
     usage:{input_tokens:100,output_tokens:15,input_tokens_details:{cached_tokens:20}}});
   }
   return Response.json({id:'msg_fixture',type:'message',role:'assistant',model:'claude-sonnet-5',
   content:[{type:'text',text:'{"answer":"verified"}'}],stop_reason:'end_turn',usage:{input_tokens:100,output_tokens:15}});}});
 cleanup.push(()=>budget.close(),()=>relay.close());
 const transport=relay.grant({candidate:provider==='openai'?'openai':'adaptive',task:'offline',provider,ctx,goalId:goal.id,
  fundingKey:'existing',accountingMode:'existing',authorize:async()=>{}});
 const adapter=provider==='openai'?'openai-structured-provider':'structured-provider';
 const raw=require('../../scripts/environment-agent-demo/'+adapter).createStructuredProvider(transport);
 const request={system:'Inspect fixture.',prompt:'Read current evidence.',schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false}};
 const wrapped=require('../../src/commercial/model').wrap(db,{...ctx,goalId:goal.id},raw,'ask','relay-fixture');
 const response=await wrapped.complete(request);assert.equal(response.data.answer,'verified');
 assert.equal(upstream,1);assert.equal(budget.status().calls,1);
 const holds=(await db.query('SELECT * FROM commercial_model_cost_holds WHERE goal_id=$1',[goal.id])).rows;
 assert.equal(holds.length,1);assert.equal(holds[0].status,'SETTLED');assert.ok(holds[0].detail.nativeRelayCallId);
 // A direct request cannot reuse the already consumed commercial reservation.
 await assert.rejects(()=>raw.complete({...request,commercial:true}));assert.equal(upstream,1);
 // Native SDK transport has no outer commercial wrapper. It must reserve and
 // settle independently, using a funded credit on the same durable goal.
 const scope=await usage.ownerScopeForWorkspace(db,ctx.workspaceId);
 await usage.reserveUsage(db,scope,{meter:'ai_work_credits',units:1,idempotencyKey:`${ctx.workspaceId}:native-fixture`});
 const nativeTransport=relay.grant({candidate:provider==='openai'?'openai':'claude',task:'offline',provider,ctx,goalId:goal.id,
  fundingKey:'native-fixture',authorize:async()=>{}});
 const native=require('../../scripts/environment-agent-demo/'+adapter).createStructuredProvider(nativeTransport);
 await native.complete({...request,commercial:true});assert.equal(upstream,2);
 const nativeHolds=(await db.query('SELECT * FROM commercial_model_cost_holds WHERE goal_id=$1',[goal.id])).rows;
 assert.equal(nativeHolds.length,2);assert.ok(nativeHolds.every(h=>h.status==='SETTLED'));
 assert.ok(nativeHolds.some(h=>h.detail.providerExecutions===1));assert.equal(budget.status().unresolved,0);
});
