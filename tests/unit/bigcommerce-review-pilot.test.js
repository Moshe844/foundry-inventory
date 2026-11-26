'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const pilot=require('../../src/connections/bigcommerce-review-pilot'),policy=require('../../src/connections/launch-policy');
test('BigCommerce production test permits bind application, inventory and store and fail closed',t=>{
 const previous={...process.env};t.after(()=>{for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);});
 Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'production',BIGCOMMERCE_CLIENT_ID:'fixture-client',BIGCOMMERCE_CLIENT_SECRET:'fixture-secret'});
 const permit={appId:'fixture-client',stores:{inventory:['store7']}};
 process.env.STOCKCHIEF_PRODUCTION_BIGCOMMERCE_PILOTS=JSON.stringify(permit);
 assert.equal(policy.reason('bigcommerce',{workspaceId:'inventory'}),null);
 assert(policy.reason('bigcommerce',{workspaceId:'another-inventory'}));
 assert.equal(pilot.expected('inventory',{storeUrl:'https://store-store7.mybigcommerce.com'}),'store7');
 assert.throws(()=>pilot.expected('inventory',{storeHash:'foreign'}),/assigned/);
 const result={accountId:'store7',credentials:{storeHash:'store7',bigcommerceClientId:'fixture-client'}};
 assert.equal(pilot.evidence(result,'inventory','owner').qualificationOnly,true);
 assert.throws(()=>pilot.evidence({...result,credentials:{...result.credentials,bigcommerceClientId:'foreign'}},'inventory','owner'),/registered/);
 const {classify}=require('../../src/commercial/connector-request-cost'),def={provider:'bigcommerce',version:'v3'};
 for(const [path,method] of [['/v3/catalog/products','GET'],['/v3/inventory/locations','GET'],['/v3/inventory/items','GET'],['/v3/hooks','POST'],['/v3/hooks/1','PUT'],['/v3/inventory/adjustments/absolute','PUT']])
  assert.equal(classify(def,'https://api.bigcommerce.com/stores/store7'+path,method)?.basis,'BIGCOMMERCE_OWNED_TEST_STORE_API_INCLUDED');
 for(const [url,method] of [['https://api.bigcommerce.com/stores/foreign/v3/hooks','POST'],['https://api.bigcommerce.com/stores/store7/v3/payments','POST'],['https://api.bigcommerce.com.evil.test/stores/store7/v3/hooks','POST']])assert.equal(classify(def,url,method),null);
 assert.equal(classify({provider:'bigcommerce',version:'unversioned'},'https://login.bigcommerce.com/oauth2/token','POST')?.basis,'BIGCOMMERCE_OWNED_TEST_STORE_API_INCLUDED');
 for(const invalid of [null,[],{...permit,appId:'foreign'},{...permit,stores:[]},{...permit,stores:{inventory:['store7'],other:['store7']}},{...permit,stores:{inventory:['../foreign']}},{...permit,stores:{inventory:[]}}]){
  process.env.STOCKCHIEF_PRODUCTION_BIGCOMMERCE_PILOTS=JSON.stringify(invalid);assert.equal(pilot.allowed('inventory'),false);
 }
 process.env.STOCKCHIEF_PRODUCTION_BIGCOMMERCE_PILOTS=JSON.stringify(permit);delete process.env.BIGCOMMERCE_CLIENT_SECRET;assert.equal(pilot.allowed('inventory'),false);
});
