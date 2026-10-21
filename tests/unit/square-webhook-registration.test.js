'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),adapter=require('../../src/connections/providers/square');
test('OAuth Square setup uses verified application credentials, paginates subscriptions and preserves the merchant grant',async t=>{
 const names=['SQUARE_ENVIRONMENT','SQUARE_APPLICATION_ID','SQUARE_SANDBOX_ACCESS_TOKEN','SQUARE_WEBHOOK_SIGNATURE_KEY'],before=Object.fromEntries(names.map(n=>[n,process.env[n]])),old=global.fetch;
 t.after(()=>{global.fetch=old;for(const[n,v]of Object.entries(before))if(v===undefined)delete process.env[n];else process.env[n]=v;});
 process.env.SQUARE_ENVIRONMENT='sandbox';process.env.SQUARE_APPLICATION_ID='sandbox-fixture-app';process.env.SQUARE_SANDBOX_ACCESS_TOKEN='fixture-owner-token';delete process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
 const merchant={accessToken:'fixture-merchant-token',refreshToken:'fixture-refresh',environment:'sandbox',merchantId:'fixture-merchant'},url='https://staging.example.test/api/v1/connections/square/webhooks/con_fixture';
 const subscription={id:'fixture-subscription',notification_url:url,enabled:true,event_types:['payment.created','payment.updated','refund.created','refund.updated','order.created','order.updated','order.fulfillment.updated','catalog.version.updated','inventory.count.updated','location.created','location.updated'],api_version:'2026-08-19'};
 let mode='existing',writes=0,observedKeys=[],calls=[];
 global.fetch=async(input,init={})=>{const u=new URL(input),token=init.headers.authorization;calls.push({path:u.pathname,method:init.method||'GET',token});assert.equal(u.origin,'https://connect.squareupsandbox.com');
  let body;if(u.pathname==='/oauth2/token/status'){assert.equal(init.method,'POST');body={client_id:mode==='wrong-app'&&token.endsWith('owner-token')?'wrong-app':'sandbox-fixture-app',merchant_id:'fixture-merchant'};}
  else{assert.equal(token,'Bearer fixture-owner-token','The OAuth merchant grant must never administer subscriptions');
   if(u.pathname==='/v2/webhooks/subscriptions'&&(!init.method||init.method==='GET')){assert.equal(u.searchParams.get('include_disabled'),'true');body=mode==='new'?{}:u.searchParams.get('cursor')?{subscriptions:[subscription]}:{subscriptions:[{id:'unrelated-subscription',notification_url:'https://unrelated.example.test'}],cursor:'next-page'};}
   else if(init.method==='PUT'){writes++;assert.equal(u.pathname,'/v2/webhooks/subscriptions/fixture-subscription');assert.deepEqual(JSON.parse(init.body).subscription.notification_url,url);body={subscription};}
   else if(init.method==='POST'){writes++;const request=JSON.parse(init.body);assert(request.idempotency_key.length<=45);observedKeys.push(request.idempotency_key);body={subscription:{...subscription,signature_key:'fixture-signature'}};}
   else{assert.equal(u.pathname,'/v2/webhooks/subscriptions/fixture-subscription');body={subscription:{...subscription,signature_key:'fixture-signature'}};}
  }return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});};
 const result=await adapter.registerWebhooks({credentials:merchant,webhookUrl:url});assert.equal(result.subscriptionId,subscription.id);assert.deepEqual(result.credentials,{...merchant,webhookSignatureKey:'fixture-signature',webhookSubscriptionId:subscription.id,webhookNotificationUrl:url});assert.equal(merchant.webhookSignatureKey,undefined);assert.equal(writes,1);assert.equal(calls.filter(c=>c.path==='/v2/webhooks/subscriptions').length,2);
 mode='new';await adapter.registerWebhooks({credentials:merchant,webhookUrl:url});await adapter.registerWebhooks({credentials:merchant,webhookUrl:url});assert.equal(observedKeys[0],observedKeys[1],'Uncertain creation must retain a stable idempotency identity');
 mode='wrong-app';const prior=writes;await assert.rejects(adapter.registerWebhooks({credentials:merchant,webhookUrl:url}),/same application/);assert.equal(writes,prior,'An unrelated app token cannot create or modify a subscription');
 const count=calls.length;await assert.rejects(adapter.registerWebhooks({credentials:{...merchant,environment:'production'},webhookUrl:url}),/application-owned webhook/);assert.equal(calls.length,count,'A production connection cannot borrow sandbox authority');
 delete process.env.SQUARE_SANDBOX_ACCESS_TOKEN;await assert.rejects(adapter.registerWebhooks({credentials:merchant,webhookUrl:url}),/application-owned webhook/);assert.equal(calls.length,count,'Missing administration credentials must not silently succeed');
 process.env.SQUARE_WEBHOOK_SIGNATURE_KEY='externally-configured-key';const external=await adapter.registerWebhooks({credentials:merchant,webhookUrl:url});assert.equal(external.externallyConfigured,true);assert.equal(external.credentials.accessToken,merchant.accessToken);
});
test('many authorized merchants reuse one application subscription instead of consuming a slot per customer',async t=>{
 const names=['SQUARE_ENVIRONMENT','SQUARE_APPLICATION_ID','SQUARE_SANDBOX_ACCESS_TOKEN'],before=Object.fromEntries(names.map(n=>[n,process.env[n]])),old=global.fetch;t.after(()=>{global.fetch=old;for(const[n,v]of Object.entries(before))if(v===undefined)delete process.env[n];else process.env[n]=v;});
 process.env.SQUARE_ENVIRONMENT='sandbox';process.env.SQUARE_APPLICATION_ID='shared-app';process.env.SQUARE_SANDBOX_ACCESS_TOKEN='application-owner';const url='https://staging.example.test/api/v1/connections/square/webhooks';let saved=null,creations=0;
 global.fetch=async(input,init={})=>{const u=new URL(input),token=init.headers.authorization.slice(7);let body;
  if(u.pathname==='/oauth2/token/status')body={client_id:'shared-app',merchant_id:token==='application-owner'?'owner-merchant':token};
  else if(u.pathname==='/v2/webhooks/subscriptions'&&(!init.method||init.method==='GET'))body={subscriptions:saved?[saved]:[]};
  else if(init.method==='POST'){creations++;assert.equal(creations,1);saved={id:'shared-subscription',...JSON.parse(init.body).subscription,signature_key:'shared-fake-key'};body={subscription:saved};}
  else if(init.method==='PUT'){assert.equal(u.pathname,'/v2/webhooks/subscriptions/shared-subscription');saved={...saved,...JSON.parse(init.body).subscription};body={subscription:saved};}else throw Error('Unexpected request');return Response.json(body);};
 for(let i=0;i<12;i++){const merchantId='merchant-'+i,result=await adapter.registerWebhooks({credentials:{environment:'sandbox',merchantId,accessToken:merchantId},webhookUrl:url});assert.equal(result.subscriptionId,'shared-subscription');assert.equal(result.credentials.merchantId,merchantId);assert.equal(result.credentials.webhookNotificationUrl,url);}
 assert.equal(creations,1);
});
