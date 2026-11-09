'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('long external jobs keep their lease without reviving cancelled work',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const jobs=require('../../src/operations/postgres-job-queue');
 await t.test('a concurrent worker cannot recover an active cleanup past its initial lease',async()=>{
  const queued=(await jobs.enqueue(db,{kind:'fixture.long-cleanup',idempotencyKey:'long-cleanup'})).job;
  let started,release,calls=0;const running=new Promise(r=>started=r),held=new Promise(r=>release=r);
  const handler=async()=>{calls++;started();await held;return {cleaned:true};};handler.externalEffect=true;
  const processing=jobs.processOne(db,{[queued.kind]:handler},{owner:'cleanup-worker',leaseMs:1000});
  try{
   await running;await delay(1600);
   assert.equal(await jobs.recoverExpired(db),0,'An active handler must retain its lease beyond the initial second');
   assert.equal(await jobs.claim(db,{owner:'second-worker',kinds:[queued.kind],leaseMs:1000}),null);
  }finally{release();await processing;}
  assert.equal((await jobs.get(db,queued.id,null)).status,'COMPLETED');assert.equal(calls,1);
  await delay(1100);assert.equal(await jobs.recoverExpired(db),0);
 });
 await t.test('failure stops renewal and preserves the normal retry result',async()=>{
  const queued=(await jobs.enqueue(db,{kind:'fixture.long-failure',idempotencyKey:'long-failure'})).job;
  const handler=async()=>{await delay(1500);throw Object.assign(Error('Controlled cleanup failure'),{code:'fixture_failure'});};handler.externalEffect=true;
  const result=await jobs.processOne(db,{[queued.kind]:handler},{owner:'failure-worker',leaseMs:1000,retryAfterMs:30000});
  assert.equal(result.status,'RETRY');assert.equal(result.lastError.code,'fixture_failure');
  const before=(await db.query('SELECT lease_expires_at,updated_at FROM stockchief_runtime.jobs WHERE id=$1',[queued.id])).rows[0];
  await delay(1100);assert.deepEqual((await db.query('SELECT lease_expires_at,updated_at FROM stockchief_runtime.jobs WHERE id=$1',[queued.id])).rows[0],before);
 });
 await t.test('cancelling or replacing a lease cannot be undone by a late heartbeat or result',async()=>{
  const queued=(await jobs.enqueue(db,{kind:'fixture.cancelled',idempotencyKey:'cancelled'})).job;
  let started,release;const running=new Promise(r=>started=r),held=new Promise(r=>release=r);
  const handler=async()=>{started();await held;return {mustNotCommit:true};};handler.externalEffect=true;
  const processing=jobs.processOne(db,{[queued.kind]:handler},{owner:'cancelled-worker',leaseMs:1000});
  try{
   await running;await db.query("UPDATE stockchief_runtime.jobs SET status='CANCELLED',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[queued.id]);
   await delay(1200);
  }finally{release();await processing;}
  const result=await jobs.get(db,queued.id,null);assert.equal(result.status,'CANCELLED');assert.equal(result.result,null);assert.equal(result.leaseExpiresAt,null);
 });
});
