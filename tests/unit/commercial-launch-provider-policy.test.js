'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const providers=require('../../src/connections/providers/registry');
const policy=require('../../src/connections/launch-policy');
const connectionService=require('../../src/connections/postgres-provider-service');

test('unqualified optional providers cannot become self-service merely by configuring OAuth',()=>{
 for(const name of ['quickbooks','xero','shopify','clover','microsoft365','erp_future']){
  assert.ok(policy.reason(name));
  assert.throws(()=>policy.assertNewConnection(name),/initial self-service|qualification/);
  const visible=providers.catalog().find(row=>row.type===name);
  assert.equal(visible.available,false);
  assert.ok(visible.unavailableReason);
  if(name!=='erp_future')assert.ok(providers.get(name),'adapter remains for existing records and later qualification');
 }
 for(const name of ['square','woocommerce','gmail'])assert.equal(policy.reason(name),null);
});

test('production authorization and callback reject excluded providers before OAuth or database work',async()=>{
 for(const name of ['quickbooks','xero','shopify','clover','microsoft365']){
  await assert.rejects(connectionService.beginAuthorization(null,{workspaceId:'test',actorId:'test'},
   {providerType:name},'https://example.test'),/initial self-service|qualification/);
  await assert.rejects(connectionService.completeOAuth(null,name,{state:'test'},
   'https://example.test'),/initial self-service|qualification/);
 }
});
