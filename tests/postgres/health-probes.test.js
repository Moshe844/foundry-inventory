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
