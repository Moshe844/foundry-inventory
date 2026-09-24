'use strict';

const crypto=require('node:crypto');
const test=require('node:test');
const assert=require('node:assert/strict');
const { chromium }=require('playwright');
const { startCluster }=require('../helpers/postgres-cluster');
const { openPostgres }=require('../../src/db/postgres');
const { migratePostgres }=require('../../src/db/migrate-postgres');
const { createPostgresApp }=require('../../src/postgres-app');
const locations=require('../../src/domain/postgres-location-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const workflows=require('../../src/operations/postgres-business-workflows');
const shipping=require('../../src/shipping/postgres-service');
const jobs=require('../../src/operations/postgres-job-queue');
const runtimeHandlers=require('../../src/operations/postgres-runtime-handlers');

let buyCalls=0;let buyMode='success';
const fakeCarrier={
  async quote(){return {providerShipmentIds:['provider-shipment-1'],rates:[
    {rateId:'rate-ground-a',carrier:'ups',service:'Ground',amountMinor:1299,currency:'USD',deliveryDays:3,deliveryDate:'2026-09-26'},
    {rateId:'rate-ground-b',carrier:'ups',service:'Ground',amountMinor:1399,currency:'USD',deliveryDays:3,deliveryDate:'2026-09-26'},
    {rateId:'rate-air',carrier:'fedex',service:'Two Day',amountMinor:2499,currency:'USD',deliveryDays:2,deliveryDate:'2026-09-25'},
  ]};},
  async buy(){buyCalls+=1;if(buyMode==='ambiguous')throw Object.assign(new Error('Carrier connection ended after submission.'),
    {code:'carrier_connection_ended'});return {providerShipmentId:'provider-shipment-1',providerLabelIds:['label-1'],carrier:'ups',
    service:'Ground',trackingNumber:'1Z999AA10123456784',trackingUrl:'https://tracking.test/1Z999AA10123456784',
    labelUrl:'https://labels.test/label-1.pdf',labelFormat:'PDF',amountMinor:1299,currency:'USD',deliveryDate:'2026-09-26'};},
  async track(){return {status:'DELIVERED',detail:'Delivered at front desk',events:[
    {externalEventId:'scan-delivered-1',status:'DELIVERED',detail:'Delivered at front desk',location:'Albany, NY',occurredAt:'2026-09-25T16:00:00.000Z'},
  ]};},
  async verifyEvent(raw,headers,{webhookSecret}){
    assert.ok(Buffer.isBuffer(raw));
    assert.equal(webhookSecret,'shipping-webhook-fixture-secret');
    assert.equal(headers['x-fixture-signature'],crypto.createHmac('sha256',webhookSecret).update(raw).digest('hex'));
    return JSON.parse(raw.toString('utf8'));
  },
  readEvent(event){return event;},
};

test('real Chromium qualifies PostgreSQL rates, label, handoff and idempotent delivery tracking',
  {timeout:180000},async(context)=>{
    buyCalls=0;buyMode='success';
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-shipping-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-shipping-secret',shippingOptions:{
      verifyAccount:async()=>({provider:'shipengine',testMode:true}),providerResolver:()=>fakeCarrier,
    }});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{
      await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();
    });
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const errors=[];page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Shipping Business');
    await page.getByLabel('Your name').fill('Shipping Owner');
    await page.getByLabel('Work email').fill('shipping-pg@example.test');
    await page.getByLabel('Password').fill('shipping-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='shipping-pg@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const location=await locations.createLocation(database,ctx,{name:'Dispatch Warehouse',kind:'warehouse',
      address:'1 Main St, Monroe, NY 10950',phone:'845-555-0100'});
    const item=await catalog.createItem(database,ctx,{name:'Shipping Widget',baseCode:'SHIP-WIDGET',
      trackingMode:'quantity',unitLabel:'unit'});
    const at='2026-09-23T00:00:00.000Z';
    await database.query(`INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at)
      VALUES('shipping-supplier',$1,'Widget Supply','active','USD',$2,$2)`,[ctx.workspaceId,at]);
    await database.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,purchase_unit,
      units_per_purchase_unit,last_unit_cost,is_preferred,is_active,created_at,updated_at)
      VALUES('shipping-supplier-item',$1,'shipping-supplier',$2,'unit',1,5.00,1,1,$3,$3)`,
    [ctx.workspaceId,item.skuIds[0],at]);
    await database.query(`INSERT INTO customers(id,workspace_id,name,email,phone,shipping_address,record_state,
      created_by_user_id,created_at,updated_at) VALUES('shipping-customer',$1,'Albany Buyer','buyer@example.test',
      '518-555-0100','10 Jobsite Rd, Albany, NY 12207','ACTIVE',$2,$3,$3)`,[ctx.workspaceId,ctx.actorId,at]);
    const po=await workflows.createPurchaseOrder(database,ctx,{supplierId:'shipping-supplier',
      destinationLocationId:location.id,idempotencyKey:'shipping-po-create',
      lines:[{skuId:item.skuIds[0],quantityUnits:10,unitCost:5}]});
    await workflows.approvePurchaseOrder(database,ctx,po.purchaseOrderId,{idempotencyKey:'shipping-po-approve'});
    await workflows.placePurchaseOrder(database,ctx,po.purchaseOrderId,{idempotencyKey:'shipping-po-place'});
    await workflows.receivePurchaseOrder(database,ctx,po.purchaseOrderId,{idempotencyKey:'shipping-po-receive',
      reference:'SHIP-RECEIPT',lines:[{lineId:po.lineIds[0],quantity:10,locationId:location.id}]});
    const order=await workflows.createSalesOrder(database,ctx,{customerId:'shipping-customer',deliveryMethod:'SHIP',
      fulfillmentLocationId:location.id,idempotencyKey:'shipping-order-create',
      lines:[{skuId:item.skuIds[0],quantity:2,unitPriceMinor:1200}]});
    const confirmed=await workflows.confirmSalesOrder(database,ctx,order.salesOrderId,{idempotencyKey:'shipping-order-confirm'});
    const parcel=await shipping.prepare(database,ctx,order.salesOrderId,{idempotencyKey:'shipping-parcel-prepare',
      lines:[{lineId:order.lineIds[0],locationId:location.id,quantity:2}]});

    await page.goto(`${base}/settings/shipping`);
    await page.locator('details#existing-carrier-connection > summary').click();
    await page.getByLabel('Shipping platform').selectOption('shipengine');
    await page.getByLabel('API key').fill('TEST_shipping_fixture_1234');
    await page.getByLabel(/Webhook secret/).fill('shipping-webhook-fixture-secret');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Verify and connect'}).click()]);
    const connectedShipping=await page.locator('main').innerText();
    assert.match(connectedShipping,/Sandbox connected/);
    assert.match(connectedShipping,/ShipEngine/);
    assert.doesNotMatch(connectedShipping,/TEST_shipping_fixture/);
    assert.doesNotMatch(connectedShipping,/shipping-webhook-fixture-secret/);
    await page.getByText('Advanced connection details',{exact:true}).click();
    const connectionDetails=await page.locator('main').innerText();
    assert.match(connectionDetails,/key ending 1234/);
    assert.match(connectionDetails,new RegExp(`/webhooks/shipping/shipengine/${ctx.workspaceId}`));
    await page.getByLabel('Recommend').check();
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save handling'}).click()]);
    await page.getByLabel('Carrier (optional)').selectOption('ups');await page.getByLabel('Service (optional)').fill('Ground');
    await page.getByLabel('Only when it costs less than').fill('25.00');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save this rule'}).click()]);
    assert.match(await page.locator('main').innerText(),/UPS Ground · under \$25\.00/);

    await page.goto(`${base}/fulfilment/${parcel.shipmentId}`);
    assert.match(await page.locator('main').innerText(),/Enter a measured package weight/);
    await page.getByLabel('Weight of this parcel (grams)').fill('850');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save weight'}).click()]);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Get carrier rates'}).click()]);
    assert.equal(await page.getByText(/UPS Ground/i).count(),1);
    assert.equal(await page.getByText(/FedEx Two Day/i).count(),1);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Buy label'}).click()]);
    assert.match(await page.locator('main').innerText(),/Carrier confirmation pending/);
    assert.equal(buyCalls,0);
    assert.equal((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand,'10');
    const handled=await jobs.processOne(database,runtimeHandlers.create(undefined,{shippingProviderResolver:()=>fakeCarrier}),
      {owner:'shipping-ui-worker',leaseMs:30000});
    assert.equal(handled.status,'COMPLETED');
    assert.equal(buyCalls,1);
    assert.equal(await jobs.processOne(database,runtimeHandlers.create(undefined,{shippingProviderResolver:()=>fakeCarrier}),
      {owner:'shipping-ui-worker',leaseMs:30000}),null);
    assert.equal(buyCalls,1);
    await page.reload();
    assert.match(await page.locator('main').innerText(),/still counts these goods in inventory/i);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:/Handed to carrier/}).click()]);
    assert.equal((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand,'8');

    const exceptionPayload=JSON.stringify({externalEventId:'carrier-exception-1',type:'tracking.updated',
      trackingNumber:'1Z999AA10123456784',status:'FAILURE',detail:'Weather delay at regional hub',events:[
        {externalEventId:'scan-exception-1',status:'FAILURE',detail:'Weather delay at regional hub',
          location:'Syracuse, NY',occurredAt:'2026-09-25T12:00:00.000Z'},
      ]});
    const exceptionSignature=crypto.createHmac('sha256','shipping-webhook-fixture-secret').update(exceptionPayload).digest('hex');
    const exceptionResponse=await page.request.post(`${base}/webhooks/shipping/shipengine/${ctx.workspaceId}`,{
      data:exceptionPayload,headers:{'content-type':'application/json','x-fixture-signature':exceptionSignature},
    });
    assert.equal(exceptionResponse.status(),200);
    assert.equal((await exceptionResponse.json()).applied,true);
    await page.goto(`${base}/needs-you`);
    assert.match(await page.locator('main').innerText(),/Carrier exception on .*Weather delay at regional hub/s);

    const deliveredPayload=JSON.stringify({externalEventId:'carrier-delivered-1',type:'tracking.updated',
      trackingNumber:'1Z999AA10123456784',status:'DELIVERED',detail:'Delivered at front desk',events:[
        {externalEventId:'scan-delivered-webhook-1',status:'DELIVERED',detail:'Delivered at front desk',
          location:'Albany, NY',occurredAt:'2026-09-25T16:00:00.000Z'},
      ]});
    const deliveredSignature=crypto.createHmac('sha256','shipping-webhook-fixture-secret').update(deliveredPayload).digest('hex');
    const webhookUrl=`${base}/webhooks/shipping/shipengine/${ctx.workspaceId}`;
    const deliveredResponse=await page.request.post(webhookUrl,{data:deliveredPayload,
      headers:{'content-type':'application/json','x-fixture-signature':deliveredSignature}});
    assert.equal(deliveredResponse.status(),200);
    assert.equal((await deliveredResponse.json()).applied,true);
    const replayResponse=await page.request.post(webhookUrl,{data:deliveredPayload,
      headers:{'content-type':'application/json','x-fixture-signature':deliveredSignature}});
    assert.equal(replayResponse.status(),200);
    assert.equal((await replayResponse.json()).replayed,true);
    await page.goto(`${base}/fulfilment/${parcel.shipmentId}`);
    assert.match(await page.locator('main').innerText(),/Delivered at front desk|delivered/i);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM shipment_tracking_events
      WHERE workspace_id=$1 AND shipment_id=$2`,[ctx.workspaceId,parcel.shipmentId])).rows[0].count,'2');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM shipping_provider_events
      WHERE workspace_id=$1 AND shipment_id=$2`,[ctx.workspaceId,parcel.shipmentId])).rows[0].count,'2');
    assert.equal((await database.query('SELECT status FROM sales_orders WHERE id=$1',[order.salesOrderId])).rows[0].status,'FULFILLED');

    const uncertainOrder=await workflows.createSalesOrder(database,ctx,{customerId:'shipping-customer',deliveryMethod:'SHIP',
      fulfillmentLocationId:location.id,idempotencyKey:'shipping-uncertain-order-create',
      lines:[{skuId:item.skuIds[0],quantity:1,unitPriceMinor:1200}]});
    await workflows.confirmSalesOrder(database,ctx,uncertainOrder.salesOrderId,{idempotencyKey:'shipping-uncertain-order-confirm'});
    const uncertainParcel=await shipping.prepare(database,ctx,uncertainOrder.salesOrderId,
      {idempotencyKey:'shipping-uncertain-parcel',lines:[{lineId:uncertainOrder.lineIds[0],locationId:location.id,quantity:1}]});
    await shipping.setPackages(database,ctx,uncertainParcel.shipmentId,[{weightGrams:500,lengthMm:200,widthMm:150,heightMm:100}]);
    await shipping.quote(database,ctx,uncertainParcel.shipmentId,{provider:fakeCarrier});
    buyMode='ambiguous';
    await page.goto(`${base}/fulfilment/${uncertainParcel.shipmentId}`);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Buy label'}).click()]);
    assert.match(await page.locator('main').innerText(),/Carrier confirmation pending/);
    const stopped=await jobs.processOne(database,runtimeHandlers.create(undefined,{shippingProviderResolver:()=>fakeCarrier}),
      {owner:'shipping-ui-worker',leaseMs:30000});
    assert.equal(stopped.status,'DEAD');assert.equal(buyCalls,2);
    assert.equal(await jobs.processOne(database,runtimeHandlers.create(undefined,{shippingProviderResolver:()=>fakeCarrier}),
      {owner:'shipping-ui-worker',leaseMs:30000}),null);
    assert.equal(buyCalls,2);
    const uncertainEffect=(await database.query(`SELECT status FROM stockchief_runtime.provider_effects
      WHERE workspace_id=$1 AND aggregate_id=$2`,[ctx.workspaceId,uncertainParcel.shipmentId])).rows[0];
    assert.equal(uncertainEffect.status,'AMBIGUOUS');
    assert.equal((await database.query(`SELECT status FROM shipping_label_transactions
      WHERE workspace_id=$1 AND shipment_id=$2`,[ctx.workspaceId,uncertainParcel.shipmentId])).rows[0].status,'REVIEW');
    await page.reload();
    assert.match(await page.locator('main').innerText(),/Carrier outcome needs review/);
    await page.goto(`${base}/needs-you`);
    const needsText=await page.locator('main').innerText();
    assert.match(needsText,/Verify shipping label purchase with shipengine/);
    assert.equal((needsText.match(/Verify shipping label purchase with shipengine/g)||[]).length,1);
    assert.equal((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand,'8');
    assert.deepEqual(errors,[]);
  });
