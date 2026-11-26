'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const rollout=require('../../src/connections/bigcommerce-customer-rollout'),policy=require('../../src/connections/launch-policy');
test('customer cohort needs exact app, distribution, commercial approval and bounded unique stores',t=>{
 const before={...process.env};t.after(()=>{for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);});
 Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'production',BIGCOMMERCE_CLIENT_ID:'client',BIGCOMMERCE_CLIENT_SECRET:'secret'});
 delete process.env.STOCKCHIEF_PRODUCTION_BIGCOMMERCE_PILOTS;
 const config={appId:'client',distributionApproved:true,commercialApproved:true,approvalReference:'fixture reviewed terms',stores:{inventory:['store7']}};
 const set=value=>process.env.STOCKCHIEF_BIGCOMMERCE_CUSTOMER_COHORT=JSON.stringify(value);
 for(const value of [null,{}, {...config,appId:'other'}, {...config,distributionApproved:false}, {...config,commercialApproved:false}, {...config,approvalReference:''}, {...config,stores:[]}, {...config,stores:{}}, {...config,stores:{a:['store7'],b:['store7']}}, {...config,stores:{a:['../store']}}, {...config,stores:{a:Array.from({length:11},(_,i)=>'store'+i)}}]){
  set(value);assert.equal(rollout.cohort(),null);assert(policy.reason('bigcommerce',{workspaceId:'inventory'}));
 }
 set(config);assert.equal(policy.reason('bigcommerce',{workspaceId:'inventory'}),null);assert(policy.reason('bigcommerce',{workspaceId:'other'}));
 assert.equal(policy.metadata({type:'bigcommerce'},{workspaceId:'inventory'}).pilot,false);
 assert.equal(rollout.expected('inventory',{storeUrl:'https://store-store7.mybigcommerce.com'}),'store7');
 assert.throws(()=>rollout.expected('inventory',{storeHash:'other'}),/approved customer rollout/);
 const result={accountId:'store7',credentials:{storeHash:'store7',bigcommerceClientId:'client'}};
 assert.equal(rollout.evidence(result,'inventory','owner').qualificationOnly,false);
 assert.throws(()=>rollout.evidence({...result,credentials:{...result.credentials,bigcommerceClientId:'other'}},'inventory','owner'),/confirm/);
 const classify=require('../../src/commercial/connector-request-cost').classify;
 assert.equal(classify({provider:'bigcommerce',version:'v3'},'https://api.bigcommerce.com/stores/store7/v3/catalog/products')?.basis,'BIGCOMMERCE_APPROVED_CUSTOMER_API_INCLUDED');
 assert.equal(classify({provider:'bigcommerce',version:'v3'},'https://api.bigcommerce.com/stores/other/v3/catalog/products'),null);
 assert.equal(classify({provider:'bigcommerce',version:'v3'},'https://api.bigcommerce.com/stores/store7/v3/payments','POST'),null);
 delete process.env.BIGCOMMERCE_CLIENT_SECRET;assert.equal(rollout.cohort(),null);
});
