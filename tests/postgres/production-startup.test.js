'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { startCluster }=require('../helpers/postgres-cluster');
const { startPostgresWeb,validateProductionEnvironment }=require('../../src/postgres-web-server');

test('production PostgreSQL startup fails closed without stable shared secrets and an HTTPS origin',()=>{
  assert.throws(()=>validateProductionEnvironment({env:'production',publicOrigin:'http://stockchief.test',
    sessionSecret:'short',encryptionKey:'short',releaseRef:'release-1'}),/HTTPS FOUNDRY_PUBLIC_URL/);
  assert.throws(()=>validateProductionEnvironment({env:'production',publicOrigin:'https://stockchief.test',
    sessionSecret:'short',encryptionKey:'x'.repeat(32),releaseRef:'release-1'}),/SESSION_SECRET/);
  assert.throws(()=>validateProductionEnvironment({env:'production',publicOrigin:'https://stockchief.test',
    sessionSecret:'s'.repeat(32),encryptionKey:'short',releaseRef:'release-1'}),/CONNECTION_ENCRYPTION_KEY/);
  assert.throws(()=>validateProductionEnvironment({env:'production',publicOrigin:'https://stockchief.test',
    sessionSecret:'s'.repeat(32),encryptionKey:'e'.repeat(32),releaseRef:'development'}),/RELEASE_REF/);
  assert.doesNotThrow(()=>validateProductionEnvironment({env:'production',publicOrigin:'https://stockchief.test',
    sessionSecret:'s'.repeat(32),encryptionKey:'e'.repeat(32),releaseRef:'release-1'}));
  assert.doesNotThrow(()=>validateProductionEnvironment({env:'production',publicOrigin:'https://stockchief.test',
    encryptionKey:'e'.repeat(32),releaseRef:'release-1',requireSession:false}));
});

test('production launcher migrates PostgreSQL and serves shared multi-writer readiness',{timeout:120000},async(context)=>{
  const cluster=await startCluster();
  const runtime=await startPostgresWeb({connectionString:cluster.connectionString,env:'test',port:0,host:'127.0.0.1',
    sessionSecret:'postgres-startup-secret',installSignalHandlers:false});
  context.after(async()=>{await runtime.close('test');cluster.stop();});
  const base=`http://127.0.0.1:${runtime.server.address().port}`;
  const health=await fetch(`${base}/healthz`);assert.equal(health.status,200);
  assert.equal((await health.json()).database,'postgresql');
  const readiness=await fetch(`${base}/readyz`);assert.equal(readiness.status,200);
  assert.deepEqual(await readiness.json(),{ok:true,database:'postgresql',shared:true,multiWriter:true,
    migrations:20,deadJobs:0,staleJobs:0});
});
