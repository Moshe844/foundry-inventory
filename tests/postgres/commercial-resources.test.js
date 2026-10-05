'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');const assert=require('node:assert/strict');const express=require('express');
const {startCluster}=require('../helpers/postgres-cluster');const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');const auth=require('../../src/domain/postgres-auth-service');
const metrics=require('../../src/commercial/resource-metrics');const context=require('../../src/commercial/context');
const jobs=require('../../src/operations/postgres-job-queue');
test('shared resource measurements preserve attribution and failed work without pricing assumptions',{timeout:90000},async t=>{
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString);t.after(async()=>{await db.close();cluster.stop();});
 await migratePostgres(db);
 const a=await auth.createBusiness(db,{name:'Resource A',businessName:'A',email:'resource-a@example.test',password:'Resource-tests-password!'});
 const b=await auth.createBusiness(db,{name:'Resource B',businessName:'B',email:'resource-b@example.test',password:'Resource-tests-password!'});
 const scope=x=>({accountId:x.accountId,workspaceId:x.workspaceId});
 await t.test('both additive migrations roll back and reapply without changing accounts or checkout',async()=>{
  const fs=require('node:fs');const path=require('node:path');
  for(const [name,table] of [['029-commercial-email-deliveries.sql','commercial_email_deliveries'],['030-commercial-resource-measurements.sql','commercial_resource_measurements']]){
   // Only the newly created, disposable fixture; the tables are empty here.
   const sql=fs.readFileSync(path.join(__dirname,'../../src/db/postgres-migrations',name),'utf8');
   await db.query(`DROP TABLE ${table}`);await db.query('DELETE FROM stockchief_postgres_migrations WHERE name=$1',[name]);
   await assert.rejects(()=>db.transaction(async client=>{await client.query(sql);throw Error('expected rollback');}),/expected rollback/);
   assert.equal((await db.query('SELECT to_regclass($1) AS table_name',[table])).rows[0].table_name,null);
   await migratePostgres(db);assert.ok((await db.query('SELECT to_regclass($1) AS table_name',[table])).rows[0].table_name);
  }
  assert.equal(Number((await db.query('SELECT count(*) FROM accounts')).rows[0].count),2);
  const release=(await db.query('SELECT * FROM commercial_release_control')).rows[0];assert.equal(release.checkout_enabled,false);
  assert.equal(release.economics_approved_at,null);assert.equal(release.readiness_approved_at,null);
 });
 await t.test('concurrent tenant measurements do not mix and count actual database attempts',async()=>{
  await Promise.all([a,b].map(person=>metrics.measure(db,{id:person.accountId,runtimeKind:'worker',operation:'test',scope:scope(person)},async()=>{
   await db.query('SELECT pg_sleep(0.01)');await db.transaction(client=>client.query('SELECT 1'));
  })));
  const rows=(await db.query("SELECT * FROM commercial_resource_measurements WHERE operation='test'")).rows;
  assert.equal(rows.length,2);for(const row of rows){assert.equal(row.account_id,row.id);assert.equal(row.attribution,'TENANT');
   assert.equal(Number(row.database_queries),2);assert.ok(Number(row.database_microseconds)>0);assert.ok(Number(row.elapsed_microseconds)>0);}
 });
 await t.test('cross-account and unauthenticated work remain explicit shared overhead',async()=>{
  await metrics.measure(db,{id:'mixed',runtimeKind:'worker',operation:'mixed',scope:scope(a)},()=>context.run({scope:scope(b)},()=>db.query('SELECT 1')));
  await metrics.measure(db,{id:'shared',runtimeKind:'worker',operation:'shared'},()=>db.query('SELECT 1'));
  const rows=(await db.query("SELECT id,account_id,attribution FROM commercial_resource_measurements WHERE id IN ('mixed','shared') ORDER BY id")).rows;
  assert.deepEqual(rows,[{id:'mixed',account_id:null,attribution:'MIXED'},{id:'shared',account_id:null,attribution:'SHARED'}]);
 });
 await t.test('rolled-back worker attempts still retain their workload measurements',async()=>{
  await jobs.enqueue(db,{kind:'resource.failure',workspaceId:a.workspaceId,idempotencyKey:'failure',maxAttempts:1});
  const result=await jobs.processOne(db,{'resource.failure':async(job,client)=>{await client.query('SELECT 1');throw Error('controlled rollback');}},{owner:'resource-test'});
  assert.equal(result.status,'DEAD');const row=(await db.query("SELECT * FROM commercial_resource_measurements WHERE operation='resource.failure'")).rows[0];
  assert.equal(row.outcome,'FAILED');assert.equal(row.account_id,a.accountId);assert.ok(Number(row.database_queries)>=3);
 });
 await t.test('web telemetry retains route templates, never query secrets, and does not charge usage',async()=>{
  const app=express();app.use(metrics.middleware(db));app.get('/test/:id',async(req,res)=>{
   req.account={id:b.accountId};await db.query('SELECT 1');res.json({ok:true});});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  try{const response=await fetch(`http://127.0.0.1:${server.address().port}/test/private-value?token=never-store`);assert.equal(response.status,200);
   for(let i=0;i<30;i++){if((await db.query("SELECT 1 FROM commercial_resource_measurements WHERE runtime_kind='web'")).rows.length)break;await new Promise(r=>setTimeout(r,10));}
   const row=(await db.query("SELECT * FROM commercial_resource_measurements WHERE runtime_kind='web'")).rows[0];
   assert.equal(row.operation,'GET /test/:id');assert.equal(row.account_id,b.accountId);assert.doesNotMatch(JSON.stringify(row),/private-value|never-store/);
   assert.equal(Number((await db.query('SELECT count(*) FROM commercial_usage_events')).rows[0].count),0);
  }finally{await new Promise(r=>server.close(r));}
 });
 await t.test('allocation candidates expose unattributed overhead and never fabricate a price',async()=>{
  const report=await metrics.weights(db,{resourceId:process.env.RENDER_SERVICE_ID||process.env.STOCKCHIEF_RESOURCE_ID||'local:worker',
    periodStart:'2020-01-01',periodEnd:'2099-01-01'});
  assert.ok(report.rows.some(row=>row.attribution==='SHARED'));assert.equal(report.readyForAutomaticAllocation,false);
  assert.equal(metrics.status().persistenceFailures,0);
  await assert.rejects(()=>metrics.weights(db,{metric:'DROP TABLE'}),/Unknown/);
  const coverage=await require('../../src/commercial/cost-coverage').report(db);
  assert.equal(coverage.completeCostCoverage,false);assert.equal(coverage.unmeteredOperationCount,null);assert.ok(coverage.resources.length>=3);
 });
 await t.test('missing connected-provider rates produce separate warnings for each tenant',async()=>{
  const control=require('../../src/commercial/control-service');
  for(const person of [a,b])await control.recordCost(db,scope(person),{provider:'contract-not-verified',operation:'http_request',unit:'request',quantity:1,
   providerVersion:'v1',idempotencyKey:'same-provider-operation'});
  const warnings=(await db.query("SELECT account_id FROM commercial_critical_warnings WHERE code='MISSING_COST_RATE' AND detail->>'provider'='contract-not-verified'")).rows;
  assert.deepEqual(warnings.map(row=>row.account_id).sort(),[a.accountId,b.accountId].sort());
  const coverage=await require('../../src/commercial/cost-coverage').report(db);assert.equal(coverage.observedMissingRateEvents,2);
  assert.equal(coverage.observedOperations[0].known_cost_minor,null);
 });
});
