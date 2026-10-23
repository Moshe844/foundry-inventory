'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('customer webhook setup is durable, encrypted, idempotent and rejects unauthenticated updates',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,shipping}=f,accounts=require('../../src/shipping/postgres-accounts'),setup=require('../../src/shipping/postgres-webhook-setup');
 const account=await accounts.forWorkspace(db,ctx.workspaceId);assert(account.webhookSecret);
 let registrations=0;const provider={...require('../../src/shipping/providers/shippo'),async ensureWebhook(_ctx,input){registrations++;assert.equal(input.webhookSecret,account.webhookSecret);assert.equal(input.testMode,true);return {status:'CONNECTED',id:'webhook-fixture'};},
  async quote(){return {rates:[{rateId:'g',carrier:'usps',service:'Ground',amountMinor:100,currency:'USD'}]};},async buy(){return {providerShipmentId:'test-label',trackingNumber:'TEST-TRACK',labelUrl:'https://example.test/label.pdf',amountMinor:100,currency:'USD'};}};
 await setup.enqueue(db,ctx,account.connectorId,{publicOrigin:'https://stockchief.example.test'});await setup.enqueue(db,ctx,account.connectorId,{publicOrigin:'https://stockchief.example.test'});
 const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{shippingProviderResolver:()=>provider});
 const job=await require('../../src/operations/postgres-job-queue').processOne(db,{'shipping.webhook.setup':handlers['shipping.webhook.setup']},{owner:'setup-fixture'});assert.equal(job.status,'COMPLETED');assert.equal(registrations,1);
 const saved=(await db.query('SELECT * FROM shipping_webhook_setups WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];assert.equal(saved.status,'CONNECTED');assert(!JSON.stringify(saved).includes(account.webhookSecret));
 const p=await f.parcel(),rates=await shipping.quote(db,ctx,p.shipmentId,{provider});await shipping.buyLabel(db,ctx,p.shipmentId,rates.rates[0].id,{idempotencyKey:'buy'},{provider});
 const app=require('express')();app.use(require('../../src/web/routes/postgres-shipping-webhooks').createPostgresShippingWebhooks(db,{providerResolver:()=>provider}));
 const server=await new Promise(resolve=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});f.cleanup(()=>new Promise(resolve=>server.close(resolve)));
 const url='http://127.0.0.1:'+server.address().port+'/webhooks/shipping/shippo/'+ctx.workspaceId;
 const event=status=>JSON.stringify({event:'track_updated',data:{object_id:'one-tracker',tracking_number:'TEST-TRACK',tracking_status:{status,status_date:'2026-10-23T13:00:00Z'}}});
 const post=(suffix,body)=>fetch(url+suffix,{method:'POST',headers:{'content-type':'application/json'},body});
 assert.equal((await post('',event('TRANSIT'))).status,401);assert.equal((await post('?token=wrong',event('TRANSIT'))).status,401);
 const token='?token='+encodeURIComponent(account.webhookSecret);
 assert.equal((await (await post(token,event('TRANSIT'))).json()).applied,true);
 assert.equal((await (await post(token,event('TRANSIT'))).json()).replayed,true);
 assert.equal((await (await post(token,event('DELIVERED'))).json()).applied,true);
 assert.equal((await shipping.requireShipment(db,ctx.workspaceId,p.shipmentId)).tracking_status,'DELIVERED');assert.equal(await f.balance(),4);
 assert.equal((await db.query('SELECT count(*)::int n FROM shipping_provider_events WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,2);
});
