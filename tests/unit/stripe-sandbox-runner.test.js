'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const runner=require('../../scripts/run-stripe-merchant-sandbox');
const clean=()=>({CI:'true',NODE_ENV:'test',STOCKCHIEF_RUNTIME_ENV:'test'});
test('missing sandbox credentials stop before any provider call unless temporary creation is explicitly requested',()=>{
 assert.throws(()=>runner.assertCredentialsConfigured(clean()),/Save the STOCKCHIEF_CERTIFICATION_STRIPE_KEY/);
 assert.doesNotThrow(()=>runner.assertCredentialsConfigured({...clean(),STOCKCHIEF_CERTIFICATION_STRIPE_KEY:'sk_test_Sandbox123'}));
 assert.doesNotThrow(()=>runner.assertCredentialsConfigured({...clean(),STOCKCHIEF_CREATE_TEMPORARY_SANDBOX:'1'}));
});
test('provider qualification refuses production databases and credentials before starting',()=>{
 assert.doesNotThrow(()=>runner.assertSafeEnvironment(clean()));
 for(const name of ['DATABASE_URL','FOUNDRY_DATABASE_URL','STOCKCHIEF_BILLING_STRIPE_SECRET_KEY','STOCKCHIEF_BILLING_STRIPE_WEBHOOK_SECRET','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STOCKCHIEF_SANDBOX_STRIPE_KEY']){
  assert.throws(()=>runner.assertSafeEnvironment({...clean(),[name]:'private-value'}),/Unexpected existing credential/);
 }
 assert.throws(()=>runner.assertSafeEnvironment({...clean(),STOCKCHIEF_RUNTIME_ENV:'production'}));
 assert.throws(()=>runner.assertSafeEnvironment({...clean(),NODE_ENV:'production'}));
 assert.throws(()=>runner.assertSafeEnvironment({...clean(),CI:''}));
});
test('only explicit test-key modes can reach the provider',()=>{
 for(const key of ['sk_test_Sandbox123','rk_test_Sandbox123','rkcs_test_Sandbox123'])assert.doesNotThrow(()=>runner.assertTestKey(key));
 for(const key of ['sk_live_Forbidden','rk_live_Forbidden','oak_Forbidden','','rk_test_injected\nHeader: value']){
  assert.throws(()=>runner.assertTestKey(key),/Only a sandbox test key/);
  assert.throws(()=>runner.assertSafeEnvironment({...clean(),STOCKCHIEF_CERTIFICATION_STRIPE_KEY:key||'invalid'}),/Only a sandbox test key/);
 }
});
test('downloadable diagnostics redact keys and private claim links',()=>{
 const secrets=['sk_test_DownloadProof123','pk_test_DownloadProof456','https://dashboard.stripe.com/onboard_sandbox/private-claim'];
 const output=runner.redactPrivate(JSON.stringify({error:'request rejected',secret:secrets[0],publishable:secrets[1],claim:secrets[2]}),secrets);
 for(const value of secrets)assert(!output.includes(value));
 assert(output.includes('request rejected'));
 assert.doesNotThrow(()=>runner.assertPrivateProof(output,secrets));
 for(const secret of secrets)assert.throws(()=>runner.assertPrivateProof(JSON.stringify({accidental:secret}),secrets),/must not appear/);
});
