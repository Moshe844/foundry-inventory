'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../../src/connections/launch-policy'),adapter=require('../../src/connections/providers/shopify');
const savedEnv={...process.env},savedFetch=global.fetch,shop='approved-sotre.myshopify.com';
test.afterEach(()=>{process.env={...savedEnv};global.fetch=savedFetch;});
function configure(){process.env.STOCKCHIEF_RUNTIME_ENV='production';process.env.STOCKCHIEF_PRIVATE_PRODUCTION_PILOT='0';process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS=JSON.stringify({'pilot-inventory':[shop]});}
test('production Shopify is closed without a valid inventory/store map and ignores staging grants',()=>{
 configure();process.env.STOCKCHIEF_STAGING_CONNECTION_WORKSPACES='pilot-inventory';process.env.STOCKCHIEF_STAGING_CONNECTION_PROVIDERS='shopify';
 for(const value of ['', 'not-json','null','[]','{"pilot-inventory":["*.myshopify.com"]}','{"pilot-inventory":[]}','{"pilot-inventory":["https://approved-sotre.myshopify.com"]}']){
  process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS=value;
  assert.throws(()=>policy.assertNewConnection('shopify',{workspaceId:'pilot-inventory'}));
  assert.throws(()=>policy.assertCallbackProvider('shopify'));
 }
});
test('only the configured inventory sees a pilot; credentials and other provider gates remain required',()=>{
 configure();const ctx={workspaceId:'pilot-inventory'};
 assert.doesNotThrow(()=>policy.assertNewConnection('shopify',ctx));assert.doesNotThrow(()=>policy.assertCallbackProvider('shopify'));
 assert.throws(()=>policy.assertNewConnection('shopify',{workspaceId:'other-inventory',pilotAllowed:true}));
 assert.throws(()=>policy.assertNewConnection('shopify'));assert.throws(()=>policy.assertNewConnection('clover',ctx));assert.throws(()=>policy.assertNewConnection('quickbooks',ctx));
 assert.equal(policy.metadata({type:'shopify',available:false},ctx).available,false);
 assert.equal(policy.metadata({type:'shopify',available:true},ctx).pilot,true);
 assert.equal(policy.metadata({type:'shopify',available:true},{workspaceId:'other-inventory'}).available,false);
 process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS='{}';assert.throws(()=>policy.assertNewConnection('shopify',ctx));
});
test('authorization checks the exact store and locks a still-active inventory',async()=>{
 configure();let reads=0,alive=true;
 const db={async query(sql,args){reads++;assert.match(sql,/deletion_requested_at IS NULL FOR SHARE/);assert.deepEqual(args,['pilot-inventory']);return {rows:alive?[{id:args[0]}]:[]};}},ctx={workspaceId:'pilot-inventory'};
 await policy.assertWorkspaceConnection(db,'shopify',ctx,{shop:'approved-sotre'});assert.equal(reads,1);
 await assert.rejects(policy.assertWorkspaceConnection(db,'shopify',ctx,{shop:'approved-store.myshopify.com'}),/approved only/);assert.equal(reads,1);
 await assert.rejects(policy.assertWorkspaceConnection(db,'shopify',{workspaceId:'another'},{shop}),/qualification/);assert.equal(reads,1);
 alive=false;await assert.rejects(policy.assertWorkspaceConnection(db,'shopify',ctx,{shop}),/no longer available/);
 process.env.STOCKCHIEF_RUNTIME_ENV='test';assert.throws(()=>policy.assertNewConnection('shopify',ctx));
});
test('Shopify HTML installation errors identify the exact store without exposing provider HTML',async()=>{
 process.env.SHOPIFY_CLIENT_ID='fixture-client';process.env.SHOPIFY_CLIENT_SECRET='fixture-secret';
 global.fetch=async(url,options)=>{assert.equal(new URL(url).hostname,shop);assert.equal(options.parseErrorBody,undefined);return new Response('<title>400 - Oauth error app_not_installed</title><p>fixture-secret</p>',{status:400,headers:{'content-type':'text/html'}});};
 await assert.rejects(adapter.tryDirectAuthorization({input:{shop}}),error=>{
  assert.match(error.message,/not installed on approved-sotre/);assert.match(error.message,/exact myshopify.com address/);assert.doesNotMatch(error.message,/fixture-secret|<title>|uninstall/i);return true;
 });
});
test('a genuine HTML cross-organization error falls back to merchant consent',async()=>{
 process.env.SHOPIFY_CLIENT_ID='fixture-client';process.env.SHOPIFY_CLIENT_SECRET='fixture-secret';
 global.fetch=async()=>new Response('<title>400 - Oauth error shop_not_permitted</title>',{status:400});
 assert.equal(await adapter.tryDirectAuthorization({input:{shop}}),null);
});
test('an error code in unrelated HTML body text cannot claim a merchant-consent fallback',async()=>{
 process.env.SHOPIFY_CLIENT_ID='fixture-client';process.env.SHOPIFY_CLIENT_SECRET='fixture-secret';
 global.fetch=async()=>new Response('<title>Upstream unavailable</title><p>Oauth error shop_not_permitted</p>',{status:400});
 await assert.rejects(adapter.tryDirectAuthorization({input:{shop}}),/did not authorize/);
});
