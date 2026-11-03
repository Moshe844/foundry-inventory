'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('model financial admission and settlement each commit as one READ COMMITTED boundary',{timeout:120000},async t=>{
 const {db,ctx,owner}=await require('../helpers/postgres-shipping-fixture').fixture(t);
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source) VALUES($1,$2,'growth','COMP','CUSTOM','OFFLINE_FIXTURE')",[require('node:crypto').randomUUID(),owner.accountId]);
 await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);
 const usage=require('../../src/commercial/entitlements'),store=require('../../src/assistant/postgres-goal-store');
 const scope={accountId:owner.accountId,workspaceId:ctx.workspaceId};
 const goal=await store.claim(db,ctx,(await store.create(db,ctx,'Offline financial boundary check',{budgetMinor:100})).id);
 const fundingKey='atomic-boundary';await usage.reserveUsage(db,scope,{meter:'ai_work_credits',units:1,idempotencyKey:ctx.workspaceId+':'+fundingKey});
 let transactions=0,queries=0,failSettlement=false;
 const measured={query:(...args)=>db.query(...args),transaction:(fn,settings)=>{
  transactions++;assert.equal(settings.isolation,'READ COMMITTED');
  return db.transaction(client=>fn({query:(sql,args)=>{queries++;if(failSettlement&&sql.includes("SET status='COMMITTED'")){failSettlement=false;throw Error('OFFLINE_SETTLEMENT_FAILURE');}return client.query(sql,args);}}),settings);
 }};
 const accounting=require('../../scripts/environment-agent-demo/commercial').createCommercialAccounting(measured);
 const call={id:'one-atomic-boundary',ctx,goalId:goal.id,provider:'anthropic',body:{model:'claude-sonnet-5'},fundingKey,inputTokens:100,outputTokens:10};
 const held=await accounting.begin(call);assert.equal(transactions,1);assert(held.cost.id);const admissionQueries=queries;
 const receipt={inputTokens:100,outputTokens:10,cacheReadTokens:0,cacheWrite5mTokens:0,cacheWrite1hTokens:0,raw:{input_tokens:100,output_tokens:10}};
 failSettlement=true;await assert.rejects(accounting.complete(held,receipt),/OFFLINE_SETTLEMENT_FAILURE/);
 assert.equal((await db.query('SELECT status FROM commercial_model_cost_holds WHERE id=$1',[held.cost.id])).rows[0].status,'RESERVED');
 assert.equal((await db.query('SELECT status FROM commercial_usage_events WHERE account_id=$1 AND idempotency_key=$2',[scope.accountId,ctx.workspaceId+':'+fundingKey])).rows[0].status,'RESERVED');
 assert.equal((await db.query('SELECT count(*)::int n FROM commercial_cost_events WHERE account_id=$1 AND left(idempotency_key,length($2))=$2',[scope.accountId,held.key+':'])).rows[0].n,0,'A failed boundary must not partly settle a provider receipt');
 transactions=0;queries=0;await accounting.complete(held,receipt);assert.equal(transactions,1);const settlementQueries=queries;
 assert(admissionQueries<20,'Financial admission must use fewer than twenty statements');
 assert(settlementQueries<20,'Financial settlement must use fewer than twenty statements');
 assert.equal((await db.query('SELECT status FROM commercial_model_cost_holds WHERE id=$1',[held.cost.id])).rows[0].status,'SETTLED');
 assert.equal((await db.query('SELECT status FROM commercial_usage_events WHERE account_id=$1 AND idempotency_key=$2',[scope.accountId,ctx.workspaceId+':'+fundingKey])).rows[0].status,'COMMITTED');
 await accounting.complete(held,receipt);
 assert.equal((await db.query('SELECT count(*)::int n FROM commercial_cost_events WHERE account_id=$1 AND left(idempotency_key,length($2))=$2',[scope.accountId,held.key+':'])).rows[0].n,2,'Replayed receipts never duplicate token charges');
 const control=require('../../src/commercial/control-service'),components=[
  {provider:'anthropic',model:'claude-sonnet-5',providerVersion:'2023-06-01',operation:'model_input',unit:'token',quantity:3,idempotencyKey:'batch-cost-input'},
  {provider:'anthropic',model:'claude-sonnet-5',providerVersion:'2023-06-01',operation:'model_output',unit:'token',quantity:2,idempotencyKey:'batch-cost-output'},
  {provider:'missing-offline-provider',operation:'unpriced',unit:'token',quantity:1,idempotencyKey:'batch-cost-unknown'}];
 const recorded=await control.recordCosts(db,scope,components);assert(recorded.every(r=>r.created));
 assert(recorded.slice(0,2).every(r=>r.event.amount_minor!==null));assert.equal(recorded[2].event.amount_minor,null);assert.equal(recorded[2].event.detail.costBasis,'MISSING');
 assert((await control.recordCosts(db,scope,components)).every(r=>!r.created));
 t.diagnostic(JSON.stringify({financialAdmissionTransactions:1,financialSettlementTransactions:1,admissionQueries,settlementQueries,paidCalls:0}));
});
