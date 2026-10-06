'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');const assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');const auth=require('../../src/domain/postgres-auth-service');
const model=require('../../src/commercial/model');const budget=require('../../src/commercial/model-cost-budget');
const entitlements=require('../../src/commercial/entitlements');const {newId}=require('../../src/lib/util');
const MODEL='claude-haiku-4-5-20251001';
test('maximum model-dollar exposure reserves before calls and settles actual cost even on failure',{timeout:90000},async t=>{
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();cluster.stop();});await migratePostgres(db);
 const owner=await auth.createBusiness(db,{name:'Dollar Budget',businessName:'Dollar Budget',
  email:'dollar-budget@example.test',password:'Dollar-budget-password!'});
 await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,source)
  VALUES($1,$2,'starter','wallet-foundation:starter','COMP','CUSTOM','TEST')`,[newId('sub'),owner.accountId]);
 const scope={accountId:owner.accountId,workspaceId:owner.workspaceId};
 const request={system:'Answer about inventory.',prompt:'How much stock is available?',
  schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false}};
 const usage={provider:'anthropic',providerVersion:'2023-06-01',model:MODEL,inputTokens:100,outputTokens:50};
 let calls=0;const provider={name:'anthropic',model:MODEL,complete:async()=>{calls++;return {data:{answer:'100 units'},usage};}};
 const result=await model.wrap(db,scope,provider,'ask','normal').complete(request);
 assert.equal(result.data.answer,'100 units');assert.equal(calls,1);
 const normal=(await db.query("SELECT * FROM commercial_model_cost_holds WHERE idempotency_key=$1",
  [`${owner.workspaceId}:normal`])).rows[0];
 assert.equal(normal.status,'SETTLED');assert.ok(Number(normal.maximum_minor)>Number(normal.actual_minor));
 assert.ok(Number(normal.actual_minor)>0);
 const failureProvider={...provider,complete:async()=>{calls++;throw Object.assign(Error('Model output failed'),{usage});}};
 const priorAlert=process.env.STOCKCHIEF_AI_FAILED_COST_ALERT_USD;
 process.env.STOCKCHIEF_AI_FAILED_COST_ALERT_USD='.0001';
 t.after(()=>{if(priorAlert===undefined)delete process.env.STOCKCHIEF_AI_FAILED_COST_ALERT_USD;
  else process.env.STOCKCHIEF_AI_FAILED_COST_ALERT_USD=priorAlert;});
 await assert.rejects(()=>model.wrap(db,scope,failureProvider,'ask','failed').complete(request),/Model output failed/);
 const failed=(await db.query("SELECT * FROM commercial_model_cost_holds WHERE idempotency_key=$1",
  [`${owner.workspaceId}:failed`])).rows[0];
 assert.equal(failed.status,'SETTLED');assert.ok(Number(failed.actual_minor)>0);
 assert.equal(failed.detail.customerCreditsConsumed,false);
 const spendAlert=(await db.query("SELECT detail FROM commercial_critical_warnings WHERE account_id=$1 AND code='FAILED_AI_PROVIDER_SPEND' AND status='OPEN'",
  [scope.accountId])).rows[0];
 assert.ok(spendAlert);assert.ok(Number(spendAlert.detail.actualCostMinor)>0);
 const failedUsage=(await db.query("SELECT status FROM commercial_usage_events WHERE idempotency_key=$1",
  [`${owner.workspaceId}:failed`])).rows[0];assert.equal(failedUsage.status,'REVERSED');
 await assert.rejects(()=>model.wrap(db,scope,provider,'ask','long').complete({...request,prompt:'X'.repeat(100000)}),
  /per-operation model-cost bound/);
 assert.equal(calls,2);
 assert.equal((await db.query("SELECT status FROM commercial_usage_events WHERE idempotency_key=$1",
  [`${owner.workspaceId}:long`])).rows[0].status,'REVERSED');
 await assert.rejects(()=>model.wrap(db,scope,{...provider,model:'unpriced-new-model'},'ask','unknown-version').complete(request),
  /no verified price bound/);
 assert.equal(calls,2);
 assert.ok((await db.query("SELECT 1 FROM commercial_critical_warnings WHERE code='UNBOUNDED_MODEL_PRICE' AND status='OPEN'")).rows.length);
 const prior=process.env.STOCKCHIEF_AI_PERIOD_COST_CAP_USD_STARTER;
 process.env.STOCKCHIEF_AI_PERIOD_COST_CAP_USD_STARTER='.20';
 t.after(()=>{if(prior===undefined)delete process.env.STOCKCHIEF_AI_PERIOD_COST_CAP_USD_STARTER;
  else process.env.STOCKCHIEF_AI_PERIOD_COST_CAP_USD_STARTER=prior;});
 const concurrent=await Promise.allSettled(Array.from({length:20},(_,index)=>budget.reserve(db,scope,provider,request,
  model.POLICIES.ask,'ask',`${owner.workspaceId}:parallel-${index}`)));
 const accepted=concurrent.filter(row=>row.status==='fulfilled');assert.ok(accepted.length>=1&&accepted.length<20);
 const exposure=(await db.query(`SELECT COALESCE(SUM(CASE WHEN status IN ('RESERVED','UNKNOWN') THEN maximum_minor
  WHEN status='SETTLED' THEN actual_minor ELSE 0 END),0) AS amount FROM commercial_model_cost_holds
  WHERE account_id=$1`,[owner.accountId])).rows[0];
 assert.ok(Number(exposure.amount)<=20);
 assert.equal((await entitlements.meterState(db,scope,'ai_work_credits')).used,1);
});
