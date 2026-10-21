'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),adapter=require('../../src/connections/providers/square');
test('Square renews weekly, verifies grant ownership and preserves delivery credentials without widening permissions',async t=>{
 const keys=['SQUARE_ENVIRONMENT','SQUARE_APPLICATION_ID','SQUARE_APPLICATION_SECRET'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]])),originalFetch=global.fetch;
 t.after(()=>{global.fetch=originalFetch;for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 Object.assign(process.env,{SQUARE_ENVIRONMENT:'sandbox',SQUARE_APPLICATION_ID:'fixture-app',SQUARE_APPLICATION_SECRET:'fixture-secret'});
 const at=Date.now(),credentials={environment:'sandbox',merchantId:'merchant-one',accessToken:'old-access',refreshToken:'saved-refresh',obtainedAt:new Date(at-8*86400000).toISOString(),expiresAt:new Date(at+22*86400000).toISOString(),webhookSignatureKey:'saved-signature',webhookSubscriptionId:'saved-subscription',webhookNotificationUrl:'https://app.example.test/events'};let calls=0,wrongMerchant=false,wrongApp=false,unavailable=false;
 global.fetch=async(url,opts)=>{calls++;const route=new URL(url).pathname;if(route==='/oauth2/token'){
  assert.equal(new URL(url).hostname,'connect.squareupsandbox.com');const body=JSON.parse(opts.body);assert.equal(body.grant_type,'refresh_token');assert.equal(body.refresh_token,'saved-refresh');assert.equal(body.client_id,'fixture-app');assert.equal(body.client_secret,'fixture-secret');assert.equal(body.scopes,undefined,'Renewal must not invent broader authorization');
  if(unavailable)return Response.json({errors:[{detail:'Temporary outage'}]},{status:503});
  return Response.json({access_token:'new-access',refresh_token:'saved-refresh',merchant_id:wrongMerchant?'merchant-two':'merchant-one',expires_at:new Date(at+30*86400000).toISOString()});
 }assert.equal(route,'/oauth2/token/status');assert.equal(opts.headers.authorization,'Bearer new-access');return Response.json({client_id:wrongApp?'another-app':'fixture-app',merchant_id:'merchant-one',scopes:['ITEMS_READ']});};
 const fresh={...credentials,obtainedAt:new Date(at).toISOString(),expiresAt:new Date(at+30*86400000).toISOString()};assert.equal((await adapter.refreshCredentials(fresh)).refreshed,false);assert.equal(calls,0);
 assert.equal((await adapter.refreshCredentials({...credentials,authMode:'sandbox_personal'})).refreshed,false);assert.equal(calls,0);
 const renewed=await adapter.refreshCredentials(credentials);assert.equal(renewed.refreshed,true);assert.equal(calls,2);assert.equal(renewed.credentials.accessToken,'new-access');for(const key of ['webhookSignatureKey','webhookSubscriptionId','webhookNotificationUrl','merchantId','environment'])assert.equal(renewed.credentials[key],credentials[key]);assert.equal(credentials.accessToken,'old-access');
 const legacy={...credentials};delete legacy.obtainedAt;assert.equal((await adapter.refreshCredentials(legacy)).refreshed,true);
 const short={...fresh,expiresAt:new Date(at+60000).toISOString()};assert.equal((await adapter.refreshCredentials(short)).refreshed,true);
 wrongMerchant=true;await assert.rejects(adapter.refreshCredentials(credentials),/different merchant/);wrongMerchant=false;wrongApp=true;await assert.rejects(adapter.refreshCredentials(credentials),/merchant and application/);wrongApp=false;unavailable=true;await assert.rejects(adapter.refreshCredentials(credentials),e=>e.status===503);assert.equal(credentials.accessToken,'old-access');
 await assert.rejects(adapter.refreshCredentials({...credentials,refreshToken:null}),/Sign in to Square again/);
 const before=calls;await assert.rejects(adapter.refreshCredentials({...credentials,environment:'production'}),/different application environment/);assert.equal(calls,before);
});
