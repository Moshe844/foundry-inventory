'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { startCluster }=require('../helpers/postgres-cluster');
const { startPostgresWeb,validateProductionEnvironment }=require('../../src/postgres-web-server');

test('production PostgreSQL startup fails closed without stable shared secrets and an HTTPS origin',()=>{
  const production={env:'production',publicOrigin:'https://stockchief.test',sessionSecret:'s'.repeat(32),
    encryptionKey:'e'.repeat(32),releaseRef:'release-1',billingSecretKey:'sk_live_contract',
    billingWebhookSecret:'whsec_contract',emailApiKey:'re_contract',fromEmail:'StockChief <operations@stockchief.test>',
    supportEmail:'support@stockchief.test'};
  assert.throws(()=>validateProductionEnvironment({env:'production',publicOrigin:'http://stockchief.test',
    sessionSecret:'short',encryptionKey:'short',releaseRef:'release-1'}),/HTTPS FOUNDRY_PUBLIC_URL/);
  assert.throws(()=>validateProductionEnvironment({...production,sessionSecret:'short'}),/SESSION_SECRET/);
  assert.throws(()=>validateProductionEnvironment({...production,encryptionKey:'short'}),/CONNECTION_ENCRYPTION_KEY/);
  assert.throws(()=>validateProductionEnvironment({...production,releaseRef:'development'}),/RELEASE_REF/);
  assert.throws(()=>validateProductionEnvironment({...production,billingSecretKey:null}),/BILLING_STRIPE_SECRET_KEY/);
  assert.throws(()=>validateProductionEnvironment({...production,billingWebhookSecret:null}),/BILLING_STRIPE_WEBHOOK_SECRET/);
  assert.throws(()=>validateProductionEnvironment({...production,emailApiKey:null}),/RESEND_API_KEY/);
  assert.throws(()=>validateProductionEnvironment({...production,fromEmail:null}),/FOUNDRY_FROM_EMAIL/);
  assert.throws(()=>validateProductionEnvironment({...production,supportEmail:null}),/FOUNDRY_SUPPORT_EMAIL/);
  assert.doesNotThrow(()=>validateProductionEnvironment(production));
  assert.doesNotThrow(()=>validateProductionEnvironment({...production,sessionSecret:null,requireSession:false}));
  assert.doesNotThrow(()=>validateProductionEnvironment({...production,requirePaidWorkspace:false,
    billingSecretKey:null,billingWebhookSecret:null}));
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
    migrations:26,deadJobs:0,staleJobs:0});
});
