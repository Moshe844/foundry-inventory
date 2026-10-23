'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('carrier voids are durable, purchase-bound and never manufacture stock or cash',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,shipping}=f,voids=require('../../src/shipping/postgres-label-voids'),jobs=require('../../src/operations/postgres-job-queue');
 let buys=0,submissions=0,reads=0;
 const provider={async quote(){return {providerShipmentIds:['provider-parcel'],rates:[{rateId:'ground',carrier:'usps',service:'Ground',amountMinor:650,currency:'USD'}]};},
  async buy(){buys++;return {providerShipmentId:'provider-parcel-'+buys,providerLabelIds:['provider-label-'+buys],carrier:'usps',service:'Ground',trackingNumber:'TRACK-'+buys,labelUrl:'https://example.test/'+buys+'.pdf',amountMinor:650,currency:'USD'};},
  async voidLabel(_ctx,input){submissions++;assert.deepEqual(input.providerReferences,['provider-label-1']);return {status:'PENDING',references:input.providerReferences,refundStatus:'PENDING'};},
  async verifyVoid(){reads++;return reads===1?{status:'PENDING',refundStatus:'PENDING',retryAfterMs:1000}:{status:'SUCCEEDED',refundStatus:'CONFIRMED'};}};
 const p=await f.parcel(),rates=await shipping.quote(db,ctx,p.shipmentId,{provider});await shipping.buyLabel(db,ctx,p.shipmentId,rates.rates[0].id,{idempotencyKey:'label-first'},{provider});
 const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{shippingProviderResolver:()=>provider});
 await jobs.processOne(db,{'provider.effect':handlers['provider.effect']},{owner:'purchase-replay-verifier'});
 const before=(await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'void-browser-fixture',shippingOptions:{providerResolver:()=>provider}});
 const server=await new Promise(resolve=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
 const page=await browser.newPage({viewport:{width:390,height:844}}),base='http://127.0.0.1:'+server.address().port;
 await page.goto(base+'/login');await page.getByLabel('Email').fill(f.email);await page.locator('input[name=password]').fill(f.password);
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);await page.goto(base+'/fulfilment/'+p.shipmentId);
 const firstVoidKey=await page.locator('form[action$="/label/void"] input[name=idempotencyKey]').inputValue();
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Void unused label',exact:true}).click()]);
 await page.getByText('Carrier confirmation pending.',{exact:true}).waitFor();assert.equal(await page.getByRole('link',{name:'Print label',exact:true}).count(),0);
 const queued=await voids.queue(db,ctx,p.shipmentId,{idempotencyKey:firstVoidKey});
 assert.equal((await voids.queue(db,ctx,p.shipmentId,{idempotencyKey:'second-tab'})).effectId,queued.effectId);
 assert.equal(await f.balance(),4);await assert.rejects(shipping.handoff(db,ctx,p.shipmentId,{trackingNumber:'OTHER'}),/pending|void/i);
 const sent=await jobs.processOne(db,{'provider.effect':handlers['provider.effect']},{owner:'void-submitter'});assert.equal(sent.status,'COMPLETED');assert.equal(submissions,1);
 assert.equal((await shipping.requireShipment(db,ctx.workspaceId,p.shipmentId)).label_status,'VOID_PENDING');
 assert.equal((await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).some(row=>row.sourceId===queued.effectId),false,'pending provider processing is not a developer-recovery task');
 const verifying={'shipping.void.verify':handlers['shipping.void.verify']},first=await jobs.processOne(db,verifying,{owner:'void-verifier'});assert.equal(first.status,'RETRY');
 await new Promise(resolve=>setTimeout(resolve,1100));const second=await jobs.processOne(db,verifying,{owner:'void-verifier'});assert.equal(second.status,'COMPLETED');
 assert.equal((await shipping.requireShipment(db,ctx.workspaceId,p.shipmentId)).label_status,'VOIDED');assert.equal(await f.balance(),4);
 await page.getByRole('heading',{name:'Label voided',exact:true}).waitFor();assert.equal(await page.getByRole('link',{name:'Print label',exact:true}).count(),0);
 assert.equal((await voids.execute(db,ctx.workspaceId,queued.effectId,{provider})).replayed,true);assert.equal(submissions,1);
 assert.equal((await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,before,'carrier confirmation is not a bank deposit');
 const transaction=(await db.query("SELECT * FROM shipping_label_transactions WHERE workspace_id=$1 AND operation='VOID'",[ctx.workspaceId])).rows[0];assert.equal(transaction.status,'SUCCEEDED');assert.equal(transaction.refund_status,'CONFIRMED');assert.equal(transaction.amount_minor,null,'never invent a refund amount from label price');
 const fresh=await shipping.quote(db,ctx,p.shipmentId,{provider});await shipping.buyLabel(db,ctx,p.shipmentId,fresh.rates[0].id,{idempotencyKey:'replacement-label'},{provider});
 await assert.rejects(voids.queue(db,ctx,p.shipmentId,{idempotencyKey:firstVoidKey}),/different|original|purchase/i);
 await shipping.handoff(db,ctx,p.shipmentId,{idempotencyKey:'handoff'});assert.equal(await f.balance(),3);
 await assert.rejects(voids.queue(db,ctx,p.shipmentId,{idempotencyKey:'too-late'}),/already left|return workflow/i);
 t.diagnostic('Real PostgreSQL and durable worker dispatch; provider responses simulated. No stock restoration or invented bank refund.');
});
