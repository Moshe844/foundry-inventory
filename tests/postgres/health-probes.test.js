'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const session=require('express-session');
const { createPostgresApp }=require('../../src/postgres-app');

test('health and readiness remain reachable while the customer request pool is saturated',async()=>{
 let probes=0;const database={query:async()=>{throw Error('Customer pool is busy');}},probeDatabase={query:async sql=>{probes++;return {rows:[sql.includes('stale_jobs')?{migrations:155,dead_jobs:0,stale_jobs:0}:{count:155}]};}};
 const app=createPostgresApp({database,probeDatabase,sessionStore:new session.MemoryStore(),env:'test',sessionSecret:'isolated-probes'});
 await request(app).get('/healthz').expect(200);await request(app).get('/readyz').expect(200);assert.equal(probes,2);
});

test('concurrent PostgreSQL health probes share bounded database checks',async()=>{
  let now=0;
  let healthQueries=0;let readinessQueries=0;
  const database={async query(sql){
    if(sql.includes('stale_jobs')){readinessQueries+=1;await new Promise((resolve)=>setTimeout(resolve,10));
      return {rows:[{migrations:'20',dead_jobs:'0',stale_jobs:'0'}]};}
    if(sql.includes('stockchief_postgres_migrations')){healthQueries+=1;await new Promise((resolve)=>setTimeout(resolve,10));
      return {rows:[{count:'20'}]};}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const app=createPostgresApp({database,sessionStore:new session.MemoryStore(),env:'test',
    sessionSecret:'probe-test-secret',probeCacheMs:{health:30,readiness:30},probeNow:()=>now});
  const responses=await Promise.all([
    ...Array.from({length:20},()=>request(app).get('/healthz')),
    ...Array.from({length:20},()=>request(app).get('/readyz')),
  ]);
  assert.ok(responses.every((response)=>response.status===200));
  assert.equal(healthQueries,1);
  assert.equal(readinessQueries,1);
  now=31;
  await request(app).get('/healthz').expect(200);
  await request(app).get('/readyz').expect(200);
  assert.equal(healthQueries,2);
  assert.equal(readinessQueries,2);
  await request(app).get('/healthz').set('Origin','https://stockchief-staging-status.onrender.com').expect('Access-Control-Allow-Origin','https://stockchief-staging-status.onrender.com').expect(200);
  const other=await request(app).get('/healthz').set('Origin','https://another.example.test');assert.equal(other.headers['access-control-allow-origin'],undefined);assert.equal(other.headers['access-control-allow-credentials'],undefined);
});

test('a slow health check stays shared even after its nominal cache window passes',async()=>{
  let now=0,queries=0,releaseQuery,startedQuery;
  const started=new Promise((resolve)=>{startedQuery=resolve;});
  const gate=new Promise((resolve)=>{releaseQuery=resolve;});
  const database={async query(){queries++;startedQuery();await gate;return {rows:[{count:'20'}]};}};
  const app=createPostgresApp({database,sessionStore:new session.MemoryStore(),env:'test',
    sessionSecret:'slow-probe-test-secret',probeCacheMs:{health:30,readiness:30},probeNow:()=>now});
  const first=request(app).get('/healthz').then((response)=>response);
  await started;
  now=100;
  const second=request(app).get('/healthz').then((response)=>response);
  releaseQuery();
  const responses=await Promise.all([first,second]);
  assert.ok(responses.every((response)=>response.status===200));
  assert.equal(queries,1);
});

test('readiness counts stalled runnable jobs while ignoring disabled and deleting inventories',{timeout:180000},async t=>{
 process.env.NODE_ENV='test';
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 await db.query("INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES('probe-owner','probe@example.test','Probe','fixture',now())");
 await db.query("INSERT INTO workspaces(id,name,owner_account_id,created_at) VALUES('probe-active','Active','probe-owner',now()),('probe-deleting','Deleting','probe-owner',now())");
 await db.query("UPDATE workspaces SET deletion_requested_at=now() WHERE id='probe-deleting'");
 const jobs=require('../../src/operations/postgres-job-queue'),old=Date.now()-600000;
 const active=(await jobs.enqueue(db,{workspaceId:'probe-active',kind:'fixture.probe',idempotencyKey:'active',now:old})).job;
 await jobs.enqueue(db,{workspaceId:'probe-deleting',kind:'fixture.probe',idempotencyKey:'deleting',now:old});
 const app=createPostgresApp({database:db,sessionStore:new session.MemoryStore(),env:'test',sessionSecret:'eligible-probe-test',probeCacheMs:{readiness:0}});
 let response=await request(app).get('/readyz').expect(503);assert.equal(response.body.staleJobs,1);
 await db.query("INSERT INTO platform_account_access(account_id,disabled_at,reason,changed_by) VALUES('probe-owner',now(),'Fixture suspension','probe-owner')");
 response=await request(app).get('/readyz').expect(200);assert.equal(response.body.staleJobs,0);
 assert.equal(await jobs.claim(db,{owner:'probe-worker',kinds:['fixture.probe']}),null,'The excluded jobs also cannot run');
 await db.query("UPDATE platform_account_access SET disabled_at=NULL WHERE account_id='probe-owner'");
 response=await request(app).get('/readyz').expect(503);assert.equal(response.body.staleJobs,1);
 const claimed=await jobs.claim(db,{owner:'probe-worker',kinds:['fixture.probe']});assert.equal(claimed.id,active.id);
 await jobs.complete(db,claimed.id,claimed.leaseToken,{});
 response=await request(app).get('/readyz').expect(200);assert.equal(response.body.staleJobs,0);
 await jobs.enqueue(db,{kind:'fixture.probe',idempotencyKey:'global',now:old});
 response=await request(app).get('/readyz').expect(503);assert.equal(response.body.staleJobs,1,'A global stalled job still fails readiness');
});
