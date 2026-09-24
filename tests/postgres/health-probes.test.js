'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const session=require('express-session');
const { createPostgresApp }=require('../../src/postgres-app');

test('concurrent PostgreSQL health probes share bounded database checks',async()=>{
  let healthQueries=0;let readinessQueries=0;
  const database={async query(sql){
    if(sql.includes('stale_jobs')){readinessQueries+=1;await new Promise((resolve)=>setTimeout(resolve,10));
      return {rows:[{migrations:'20',dead_jobs:'0',stale_jobs:'0'}]};}
    if(sql.includes('stockchief_postgres_migrations')){healthQueries+=1;await new Promise((resolve)=>setTimeout(resolve,10));
      return {rows:[{count:'20'}]};}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const app=createPostgresApp({database,sessionStore:new session.MemoryStore(),env:'test',
    sessionSecret:'probe-test-secret',probeCacheMs:{health:30,readiness:30}});
  const responses=await Promise.all([
    ...Array.from({length:20},()=>request(app).get('/healthz')),
    ...Array.from({length:20},()=>request(app).get('/readyz')),
  ]);
  assert.ok(responses.every((response)=>response.status===200));
  assert.equal(healthQueries,1);
  assert.equal(readinessQueries,1);
  await new Promise((resolve)=>setTimeout(resolve,35));
  await request(app).get('/healthz').expect(200);
  await request(app).get('/readyz').expect(200);
  assert.equal(healthQueries,2);
  assert.equal(readinessQueries,2);
});
