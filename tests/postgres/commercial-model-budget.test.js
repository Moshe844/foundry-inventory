'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');const assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');const auth=require('../../src/domain/postgres-auth-service');
const budget=require('../../src/commercial/model-budget');const model=require('../../src/commercial/model');
const entitlements=require('../../src/commercial/entitlements');const {newId}=require('../../src/lib/util');
test('failed paid model attempts have an atomic durable ceiling even when customer credits reverse',{timeout:90000},async t=>{
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();cluster.stop();});await migratePostgres(db);
 const owner=await auth.createBusiness(db,{name:'AI Budget Owner',businessName:'AI Budget',
  email:'ai-budget@example.test',password:'Budget-fixture-password!'});
 await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,source)
  VALUES($1,$2,'starter','wallet-foundation:starter','COMP','CUSTOM','TEST')`,[newId('sub'),owner.accountId]);
 const control=require('../../src/commercial/control-service');
 for(const operation of ['model_input','cache_write_1h','model_output'])await control.saveCostRate(db,
  {provider:'anthropic',model:'fixture-model',providerVersion:'2023-06-01',operation,unit:'token',
   costPerUnitMinor:.0001,source:'Fixture verified model price for budget test',pricingBasis:'VERIFIED_CONTRACT',confidence:'HIGH'});
 const old=process.env.STOCKCHIEF_AI_MAX_FAILED_MODEL_ATTEMPTS_PER_DAY;
 process.env.STOCKCHIEF_AI_MAX_FAILED_MODEL_ATTEMPTS_PER_DAY='2';
 t.after(()=>{if(old===undefined)delete process.env.STOCKCHIEF_AI_MAX_FAILED_MODEL_ATTEMPTS_PER_DAY;
  else process.env.STOCKCHIEF_AI_MAX_FAILED_MODEL_ATTEMPTS_PER_DAY=old;});
 let providerCalls=0;const provider={name:'anthropic',model:'fixture-model',complete:async()=>{
  providerCalls++;throw Object.assign(Error('Provider returned unusable output'),{code:'fixture_invalid_output'});}};
 const scope={accountId:owner.accountId,workspaceId:owner.workspaceId};
 for(let index=1;index<=2;index++)await assert.rejects(()=>model.wrap(db,scope,provider,'ask',`failed-${index}`).complete(
  {system:'fixture',prompt:'fixture',schema:{type:'object',properties:{answer:{type:'string'}}}}),/unusable output/);
 assert.equal((await entitlements.meterState(db,scope,'ai_work_credits')).used,0);
 await assert.rejects(()=>model.wrap(db,scope,provider,'ask','blocked-third').complete(
  {system:'fixture',prompt:'fixture',schema:{type:'object',properties:{answer:{type:'string'}}}}),
 (error)=>error.limitKind==='daily_model_attempts'&&/daily model-attempt safety limit/.test(error.message));
 assert.equal(providerCalls,2);
 const attempts=(await db.query('SELECT attempts,failures FROM commercial_model_daily_attempts WHERE account_id=$1',
  [owner.accountId])).rows[0];assert.equal(attempts.attempts,2);assert.equal(attempts.failures,2);
 const usage=(await db.query("SELECT status FROM commercial_usage_events WHERE account_id=$1 AND idempotency_key LIKE '%blocked-third'",
  [owner.accountId])).rows[0];assert.equal(usage.status,'REVERSED');
 const concurrent=await auth.createBusiness(db,{name:'AI Parallel Owner',businessName:'AI Parallel',
  email:'ai-parallel@example.test',password:'Budget-fixture-password!'});
 const oldAttemptCap=process.env.STOCKCHIEF_AI_MAX_MODEL_ATTEMPTS_PER_DAY;
 process.env.STOCKCHIEF_AI_MAX_MODEL_ATTEMPTS_PER_DAY='3';
 t.after(()=>{if(oldAttemptCap===undefined)delete process.env.STOCKCHIEF_AI_MAX_MODEL_ATTEMPTS_PER_DAY;
  else process.env.STOCKCHIEF_AI_MAX_MODEL_ATTEMPTS_PER_DAY=oldAttemptCap;});
 const parallel=await Promise.allSettled(Array.from({length:20},()=>budget.begin(db,concurrent.accountId)));
 assert.equal(parallel.filter(result=>result.status==='fulfilled').length,3);
 assert.equal(Number((await db.query('SELECT attempts FROM commercial_model_daily_attempts WHERE account_id=$1',
  [concurrent.accountId])).rows[0].attempts),3);
});
