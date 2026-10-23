'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('an accepted label completes through read-only worker verification without a second purchase',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 let app,server,browser; t.after(async()=>{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));if(app)await app.locals.sessionStore.close();await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',password='Fixture!'+randomUUID();
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Async label fixture',email,password}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 await require('../../src/shipping/postgres-accounts').connect(db,ctx,{provider:'shippo',apiKey:'shippo_test_pending_fixture'});
 const location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Dispatch',kind:'warehouse',address:'1 Main St, Monroe, NY 10950',phone:'8455550100',shippingEmail:'dispatch@example.test'});
 assert.equal(location.shipping_email,'dispatch@example.test','the canonical location stores the explicit shipping contact');
 const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Async fixture',baseCode:'ASYNC-BOX',trackingMode:'quantity'}),workflows=require('../../src/operations/postgres-business-workflows'),at=new Date().toISOString();
 await db.query(`INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('async-supplier',$1,'Fixture parts','active','USD',$2,$2)`,[ctx.workspaceId,at]);
 await db.query(`INSERT INTO customers(id,workspace_id,name,phone,shipping_address,record_state,created_by_user_id,created_at,updated_at)
   VALUES('async-customer',$1,'Fixture receiver','5185550100','10 Jobsite Rd, Albany, NY 12207','ACTIVE',$2,$3,$3)`,[ctx.workspaceId,ctx.actorId,at]);
 const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'async-supplier',destinationLocationId:location.id,idempotencyKey:'async-po',lines:[{skuId:item.skuIds[0],quantityUnits:3,unitCost:1}]});
 await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'async-po-approve'});await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'async-po-place'});
 await workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'async-receive',reference:'ASYNC-RECEIPT',lines:[{lineId:po.lineIds[0],quantity:3,locationId:location.id}]});
 const order=await workflows.createSalesOrder(db,ctx,{customerId:'async-customer',deliveryMethod:'SHIP',fulfillmentLocationId:location.id,idempotencyKey:'async-order',lines:[{skuId:item.skuIds[0],quantity:1,unitPriceMinor:1200}]});
 await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'async-confirm'});
 const shipping=require('../../src/shipping/postgres-service'),jobs=require('../../src/operations/postgres-job-queue');
 const parcel=await shipping.prepare(db,ctx,order.salesOrderId,{idempotencyKey:'async-parcel',lines:[{lineId:order.lineIds[0],locationId:location.id,quantity:1}]});
 await shipping.setPackages(db,ctx,parcel.shipmentId,[{weightGrams:300}]);
 let buys=0,reads=0;
 const pending=()=>Object.assign(Error('The provider is still preparing this accepted transaction.'),{providerOutcomeUncertain:true,providerReference:{externalId:'accepted-transaction',rateId:'async-rate'}});
 const adapter={async quote(){return {providerShipmentIds:['async-provider-parcel'],rates:[{rateId:'async-rate',carrier:'usps',service:'Ground',amountMinor:575,currency:'USD',deliveryDays:3}]};},
   async buy(){buys++;throw pending();},async verifyPurchase(_ctx,reference){assert.equal(reference.externalId,'accepted-transaction');if(++reads===1)throw pending();return {providerLabelIds:['accepted-transaction'],providerShipmentId:'accepted-transaction',carrier:'usps',service:'Ground',trackingNumber:'ASYNC-TRACK',labelUrl:'https://example.test/async.pdf',labelFormat:'PDF',amountMinor:575,currency:'USD'};}};
 const rates=await shipping.quote(db,ctx,parcel.shipmentId,{provider:adapter}),queued=await shipping.queueLabelPurchase(db,ctx,parcel.shipmentId,rates.rates[0].id,{idempotencyKey:'async-label'});
 assert.equal((await shipping.state(db,ctx.workspaceId,parcel.shipmentId)).from.email,'dispatch@example.test');
 const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{shippingProviderResolver:()=>adapter});
 const submitted=await jobs.processOne(db,{'provider.effect':handlers['provider.effect']},{owner:'async-submitter'});assert.equal(submitted.status,'COMPLETED');
 const accepted=submitted.result;assert.equal(accepted.pending,true);assert.equal(accepted.verificationQueued,true);
 await db.transaction(client=>shipping.recoverKnownLabelVerifications(client,{providerResolver:()=>adapter}));
 await db.transaction(client=>shipping.recoverKnownLabelVerifications(client,{providerResolver:()=>adapter}));
 assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE kind='shipping.label.verify' AND payload->>'effectId'=$1",[queued.effectId])).rows[0].n,1,'recovery sweeps reuse the existing verification job');
 assert.equal(buys,1);assert.equal((await shipping.requireShipment(db,ctx.workspaceId,parcel.shipmentId)).label_status,'PENDING');
 await assert.rejects(shipping.setPackages(db,ctx,parcel.shipmentId,[{weightGrams:600}]),/saved label/i);
 await assert.rejects(shipping.handoff(db,ctx,parcel.shipmentId,{idempotencyKey:'premature-handoff',trackingNumber:'ANOTHER-LABEL'}),/label.*pending|verification/i);
 assert.equal((await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).some(row=>row.sourceId===queued.effectId),false,'active verification does not ask the owner for manual recovery');
 app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'async-label-browser-fixture'});
 server=await new Promise(resolve=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});browser=await require('playwright').chromium.launch();
 const page=await browser.newPage({viewport:{width:390,height:844}}),base='http://127.0.0.1:'+server.address().port,errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+'/login');await page.locator('input[name=email]').fill(email);await page.locator('input[name=password]').fill(password);
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);await page.goto(base+'/fulfilment/'+parcel.shipmentId);
 await page.getByText('Carrier confirmation pending.',{exact:true}).waitFor();
 const csrf=await page.locator('input[name=_csrf]').first().inputValue();
 for(const [action,data]of [['destination',{deliveryMethod:'PICKUP'}],['cancel',{reason:'Second-tab change'}]]){
   const result=await page.request.post(base+'/fulfilment/'+parcel.shipmentId+'/'+action,{form:{_csrf:csrf,...data}});
   assert.match(await result.text(),/Resolve or void the saved label/);
 }
 assert.equal((await shipping.requireShipment(db,ctx.workspaceId,parcel.shipmentId)).handover,'CARRIER');
 const verificationHandlers={'shipping.label.verify':handlers['shipping.label.verify']};
 const first=await jobs.processOne(db,verificationHandlers,{owner:'async-verifier'});assert.equal(first.status,'RETRY');assert.equal(reads,1);
 await new Promise(resolve=>setTimeout(resolve,1100));
 const second=await jobs.processOne(db,verificationHandlers,{owner:'async-verifier'});assert.equal(second.status,'COMPLETED');assert.equal(reads,2);assert.equal(buys,1);
 assert.equal((await shipping.requireShipment(db,ctx.workspaceId,parcel.shipmentId)).label_status,'PURCHASED');
 await assert.rejects(shipping.setPackages(db,ctx,parcel.shipmentId,[{weightGrams:600}]),/saved label/i);
 assert.equal((await db.query('SELECT status FROM shipping_label_transactions WHERE id=$1',[queued.transactionId])).rows[0].status,'SUCCEEDED');
 assert.equal((await db.query("SELECT status FROM commercial_usage_events WHERE workspace_id=$1 AND idempotency_key=$2",[ctx.workspaceId,ctx.workspaceId+':async-label'])).rows[0].status,'COMMITTED','accepted label usage settles only after confirmation');
 assert.equal((await shipping.executeLabelPurchaseEffect(db,ctx.workspaceId,queued.effectId,{provider:adapter})).replayed,true);assert.equal(buys,1);
 assert.equal((await db.query('SELECT sum(on_hand)::int n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,3,'async completion does not issue physical stock');
 try{await page.getByRole('link',{name:'Print label',exact:true}).waitFor({timeout:10000});}
 catch(error){t.diagnostic(JSON.stringify({errors,url:page.url(),pending:await page.locator('[data-async-operation]').evaluateAll(nodes=>nodes.map(node=>({dataset:{...node.dataset},text:node.textContent}))),visibility:await page.evaluate(()=>document.visibilityState)}));throw error;}
 const laterOrder=await workflows.createSalesOrder(db,ctx,{customerId:'async-customer',deliveryMethod:'SHIP',fulfillmentLocationId:location.id,idempotencyKey:'later-order',lines:[{skuId:item.skuIds[0],quantity:1,unitPriceMinor:1200}]});
 await workflows.confirmSalesOrder(db,ctx,laterOrder.salesOrderId,{idempotencyKey:'later-confirm'});
 const laterParcel=await shipping.prepare(db,ctx,laterOrder.salesOrderId,{idempotencyKey:'later-parcel',lines:[{lineId:laterOrder.lineIds[0],locationId:location.id,quantity:1}]});
 await shipping.setPackages(db,ctx,laterParcel.shipmentId,[{weightGrams:300}]);
 let laterBuys=0;
 const terminalAdapter={...adapter,async buy(){laterBuys++;throw Object.assign(pending(),{providerReference:{externalId:'transaction-needing-review'}});},
   async verifyPurchase(){throw Object.assign(pending(),{retryable:false});}};
 const laterRates=await shipping.quote(db,ctx,laterParcel.shipmentId,{provider:terminalAdapter});
 const later=await shipping.queueLabelPurchase(db,ctx,laterParcel.shipmentId,laterRates.rates[0].id,{idempotencyKey:'later-label'});
 await shipping.executeLabelPurchaseEffect(db,ctx.workspaceId,later.effectId,{provider:terminalAdapter});
 const terminalHandlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{shippingProviderResolver:()=>terminalAdapter});
 const dead=await jobs.processOne(db,{'shipping.label.verify':terminalHandlers['shipping.label.verify']},{owner:'terminal-verifier'});
 assert.equal(dead.status,'DEAD');assert.equal(laterBuys,1);
 assert.equal((await shipping.requireShipment(db,ctx.workspaceId,laterParcel.shipmentId)).label_status,'REVIEW');
 assert((await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).some(row=>row.sourceId===later.effectId),'terminal verification is visible in Needs You');
 const recovery=await db.transaction(client=>shipping.recoverKnownLabelVerifications(client,{providerResolver:()=>terminalAdapter}));
 assert.equal(recovery.resumed,0,'a sweep cannot reset exhausted verification or submit another purchase');
 assert.equal((await db.query('SELECT status FROM stockchief_runtime.jobs WHERE id=$1',[dead.id])).rows[0].status,'DEAD');
 t.diagnostic('Real Chromium/PostgreSQL and actual durable worker dispatch; provider responses simulated; no manual reload.');
});
