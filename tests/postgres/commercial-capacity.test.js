'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const capacity=require('../../src/operations/postgres-capacity');
test('PostgreSQL commercial capacity sampler measures queue, connection, disk and pool pressure and raises alerts',
 {timeout:120000},async t=>{
 const cluster=await startCluster(),db=openPostgres(cluster.connectionString,{max:3,applicationName:'commercial-capacity-fixture'});
 t.after(async()=>{await db.close();cluster.stop();});await migratePostgres(db);
 const clean=await capacity.sample(db,{role:'worker',diskCapacityGb:15});
 const release=require('../../src/commercial/release');
 for(const code of release.LAUNCH_BLOCKERS.filter(code=>code.startsWith('UNVERIFIED_')))assert.equal((await db.query(
  "SELECT status FROM commercial_critical_warnings WHERE code=$1",[code])).rows[0].status,
  code==='UNVERIFIED_MIXED_WORKLOAD_CAPACITY'?'OPEN':'RESOLVED');
 const priorCheckout=process.env.STOCKCHIEF_CHECKOUT_ENABLED;
 const priorTax=process.env.STOCKCHIEF_BILLING_AUTOMATIC_TAX;
 try{process.env.STOCKCHIEF_CHECKOUT_ENABLED='true';
  await db.query("UPDATE commercial_release_control SET checkout_enabled=true,economics_approved_at=now(),readiness_approved_at=now() WHERE singleton=true");
  assert.equal(await release.isOpen(db),false,'unverified provider fees and mixed-workload capacity must keep checkout closed');
  await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED' WHERE code=ANY($1::text[])",
   [release.LAUNCH_BLOCKERS]);
  process.env.STOCKCHIEF_BILLING_AUTOMATIC_TAX='true';
  assert.equal(await release.isOpen(db),false,'Stripe Tax cannot be silently enabled without fee and compliance review');
 }finally{if(priorCheckout===undefined)delete process.env.STOCKCHIEF_CHECKOUT_ENABLED;
  else process.env.STOCKCHIEF_CHECKOUT_ENABLED=priorCheckout;
  if(priorTax===undefined)delete process.env.STOCKCHIEF_BILLING_AUTOMATIC_TAX;
  else process.env.STOCKCHIEF_BILLING_AUTOMATIC_TAX=priorTax;}
 assert.equal(clean.queueDepth,0);assert.ok(clean.databaseConnectionLimit>=3);
 assert.equal(clean.httpSamples5m,0);assert.equal(clean.httpP95Ms,null);
 assert.ok(clean.databaseBytes>0);assert.equal(clean.diskCapacityBytes,15*1024**3);
 assert.equal(clean.pool.max,3);assert.equal(clean.pool.waiting,0);
 const thresholds={...capacity.DEFAULTS,queueDepthWarn:1,queueDepthCritical:2,
  queueWaitWarnMs:1,queueWaitCriticalMs:1000000,connectionWarnFraction:.01,
  connectionCriticalFraction:.99,diskWarnFraction:.99,diskCriticalFraction:1,
  poolWaitingWarn:1,poolWaitingCritical:3};
 await db.query(`INSERT INTO stockchief_runtime.jobs(id,kind,payload,status,priority,max_attempts,
  available_at,idempotency_key,created_at,updated_at)
  VALUES('capacity-fixture','certification.noop','{}','PENDING',10,1,0,'capacity-fixture',now()-interval '2 minutes',now())`);
 await db.query(`INSERT INTO commercial_resource_measurements(id,resource_id,runtime_kind,operation,
  started_at,finished_at,elapsed_microseconds,database_microseconds,database_queries,attribution,outcome)
  SELECT 'http-fixture-'||n,'fixture','web','GET /inventory',now(),now(),
   CASE WHEN n=20 THEN 3000000 ELSE 1500000 END,1000,1,'SHARED',
   CASE WHEN n=20 THEN '503' ELSE '200' END FROM generate_series(1,20) n`);
 const measured=await capacity.check(db,{role:'worker',diskCapacityGb:15,thresholds});
 assert.equal(measured.snapshot.queueDepth,1);assert.ok(measured.snapshot.oldestQueueWaitMs>=100000);
 assert.equal(measured.snapshot.httpSamples5m,20);assert.equal(measured.snapshot.httpErrors5m,1);
 assert.ok(measured.snapshot.httpP95Ms>=1500);
 assert.ok(measured.alerts.some(x=>x.kind==='queue_depth'&&x.severity==='WARNING'));
 assert.ok(measured.alerts.some(x=>x.kind==='queue_wait'&&x.severity==='WARNING'));
 const stored=(await db.query("SELECT kind,status FROM operational_alerts WHERE kind LIKE 'capacity.%'")).rows;
 assert.ok(stored.some(x=>x.kind==='capacity.queue_depth'&&x.status==='OPEN'));
 const missing=capacity.evaluate({...clean,diskCapacityBytes:null});
 assert.ok(missing.some(x=>x.kind==='disk_capacity_unconfigured'&&x.severity==='ERROR'));
 const critical=capacity.evaluate({...clean,queueDepth:500,oldestQueueWaitMs:300000,
  databaseConnections:90,databaseConnectionLimit:100,databaseBytes:14*1024**3,
  diskCapacityBytes:15*1024**3,pool:{waiting:4},
  memoryLimitBytes:2*1024**3,processMemoryBytes:1.8*1024**3,cpuFraction:.9,
  httpSamples5m:100,httpErrors5m:8,httpP95Ms:2500,jobRetries5m:20,deadJobs:10});
 assert.ok(critical.filter(x=>x.severity==='ERROR').length>=11);
});
