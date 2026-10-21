'use strict';

const crypto=require('node:crypto');
const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const credentialStore=require('../../src/connections/postgres-credential-store');
const locations=require('../../src/domain/postgres-location-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const costing=require('../../src/accounting/postgres-costing');
const shopify=require('../../src/connections/providers/shopify');
const {AuthenticationError}=require('../../src/domain/errors');
const {newId,nowIso}=require('../../src/lib/util');

const webhookSecret='shopify-postgres-webhook-secret';
let legacyObservation=false,legacyShipment=false;
const signedAdapter={...shopify,normalizeWebhook(input){const events=shopify.normalizeWebhook(input);for(const event of events){if(legacyObservation)delete event.observationProof;if(legacyShipment)delete event.shipmentObservation;}return events;}};
const providers={get(type){return type==='shopify'?signedAdapter:null;},catalog(){return [];}};
const sign=(body)=>crypto.createHmac('sha256',webhookSecret).update(body).digest('base64');

for(const legacyStart of [true,false])test('real Chromium qualifies signed Shopify order creation, fulfillment and cancellation on PostgreSQL: '+(legacyStart?'interrupted shipment handoff':'fresh complete handoff'),
  {timeout:180000},async(context)=>{
    const oldSecret=process.env.SHOPIFY_CLIENT_SECRET,oldClient=process.env.SHOPIFY_CLIENT_ID,oldFetch=global.fetch;process.env.SHOPIFY_CLIENT_SECRET=webhookSecret;process.env.SHOPIFY_CLIENT_ID='fixture-shopify-client';let providerRequests=0;
    global.fetch=async(value,options)=>{const url=new URL(value);if(url.hostname==='127.0.0.1')return oldFetch(value,options);assert.equal(url.hostname,'shopify-store-1.myshopify.com','The wire fixture must never contact an actual store');providerRequests++;const id=JSON.parse(options.body).variables.id,node=/\/Order\/(1001|1002)$/.test(id)?{id}:/\/Fulfillment\/700[12]$/.test(id)?{id,order:{id:'gid://shopify/Order/'+(id.endsWith('7002')?'1002':'1001')}}:/\/Refund\/800[1-4]$/.test(id)?{id,order:{id:'gid://shopify/Order/'+(id.endsWith('8002')?'1001':'1002'),displayFinancialStatus:id.endsWith('8002')?'PAID':'VOIDED'}}:null;return Response.json({data:{node}});};
    context.after(()=>{global.fetch=oldFetch;if(oldSecret===undefined)delete process.env.SHOPIFY_CLIENT_SECRET;else process.env.SHOPIFY_CLIENT_SECRET=oldSecret;if(oldClient===undefined)delete process.env.SHOPIFY_CLIENT_ID;else process.env.SHOPIFY_CLIENT_ID=oldClient;});
    const eventDay=new Date().toISOString().slice(0,10);
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-shopify-webhooks'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-shopify-webhook-secret',connectionProviders:providers});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Shopify Webhook Business');
    await page.getByLabel('Your name').fill('Shopify Owner');await page.getByLabel('Work email').fill('shopify-webhook@example.test');
    await page.locator('input[name="password"]').fill('shopify-webhook-password');if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('shopify-webhook-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='shopify-webhook@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const location=await locations.createLocation(database,ctx,{name:'Shopify Warehouse',kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:'Shopify Bottle',baseCode:'SHOP-BOTTLE',trackingMode:'quantity',unitLabel:'unit'});
    const received=await inventory.receive(database,ctx,{skuId:item.skuIds[0],locationId:location.id,quantity:6,
      reference:'OPENING',idempotencyKey:'shopify-webhook-opening'});
    await database.transaction((client)=>costing.receiveInTransaction(client,ctx,{movementId:received.movementId,
      unitCostMinor:500,sourceType:'opening_inventory',sourceRecordId:received.movementId}));
    const connectorId=newId('con');const at=nowIso();
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,
       expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
      VALUES($1,$2,$3,'Shopify Store','shopify','connected','["WEBHOOKS"]','["customer orders","fulfillment"]','{}',
        5,'CONNECTED',$4,'shopify-store-1','Shopify test store',$5,$5)`,
    [connectorId,ctx.workspaceId,`shopify:${connectorId}`,ctx.actorId,at]);
    await credentialStore.put(database,ctx.workspaceId,connectorId,'provider',{shop:'shopify-store-1.myshopify.com',accessToken:'encrypted-token'});
    for(const [entityType,externalId,foundryRecordId] of [
      ['sku','gid://shopify/ProductVariant/501',item.skuIds[0]],['location','gid://shopify/Location/44',location.id],
    ])await database.query(`INSERT INTO connection_mappings
      (id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,confidence,approved_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'approved',$7,$8,$8)`,
    [newId('cmap'),ctx.workspaceId,connectorId,entityType,externalId,foundryRecordId,ctx.actorId,at]);
    const endpoint=`${base}/api/v1/connections/shopify/webhooks/${connectorId}`;
    const send=async(body,topic,delivery,token=sign(body))=>fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',
      'x-shopify-topic':topic,'x-shopify-webhook-id':delivery,'x-shopify-shop-domain':'shopify-store-1.myshopify.com','x-shopify-hmac-sha256':token},body});
    const order=(id,quantity=2)=>({id,name:`#${id}`,created_at:`${eventDay}T12:00:00.000Z`,updated_at:`${eventDay}T12:00:00.000Z`,
      currency:'USD',location_id:44,email:`buyer-${id}@example.test`,customer:{id:77,first_name:'Sharon',last_name:'Buyer',
        email:`buyer-${id}@example.test`},shipping_address:{address1:'20 Main Street',city:'Monroe',province:'NY',zip:'10950',country_code:'US'},
      line_items:[{id:id*10+1,variant_id:501,product_id:50,sku:'SHOP-BOTTLE',quantity,price:'15.00'}]});
    const createBody=JSON.stringify(order(1001));
    const created=await send(createBody,'orders/create','shopify-create-1001');
    assert.equal(created.status,202,await created.clone().text());assert.equal(providerRequests,0,'The signed HTTP acknowledgement must not wait for provider API reads');assert.equal((await require('../helpers/provider-webhook-worker').result(database,created,providers)).accepted,1);
    const mapped=(await database.query(`SELECT foundry_record_id FROM connection_mappings WHERE workspace_id=$1
      AND connector_id=$2 AND entity_type='sales_order' AND external_id='1001'`,[ctx.workspaceId,connectorId])).rows[0];
    assert.ok(mapped);
    const fulfillmentBody=JSON.stringify({id:7001,order_id:1001,location_id:44,created_at:`${eventDay}T13:00:00.000Z`,tracking_company:'Test carrier',tracking_number:'TEST-7001',tracking_url:'https://example.test/tracking/7001',
      updated_at:`${eventDay}T13:00:00.000Z`,line_items:[{id:10011,variant_id:501,product_id:50,sku:'SHOP-BOTTLE',quantity:2}]});
    legacyShipment=legacyStart;const fulfilled=await send(fulfillmentBody,'fulfillments/create','shopify-fulfill-1001');
    assert.equal(fulfilled.status,202);assert.equal((await require('../helpers/provider-webhook-worker').result(database,fulfilled,providers)).accepted,1);
    legacyShipment=false;
    assert.equal((await database.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,mapped.foundry_record_id])).rows[0].status,'FULFILLED');
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),4);
    // Reproduce the actual live gap: physical/invoice effects completed but
    // the shipping handoff was absent. A new delivery of that same retained
    // provider fact must repair metadata without repeating business effects.
    assert.equal(Number((await database.query('SELECT count(*) AS n FROM sales_shipments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),legacyStart?0:1);
    const effectBefore=(await database.query("SELECT movement_ids,payload_hash,normalized_payload FROM connector_feed_events WHERE workspace_id=$1 AND external_event_id='shopify-fulfill-1001'",[ctx.workspaceId])).rows[0];
    const effectCounts=async()=>(await database.query(`SELECT (SELECT count(*) FROM movements WHERE workspace_id=$1) AS movements,
      (SELECT count(*) FROM accounting_customer_invoices WHERE workspace_id=$1) AS invoices,
      (SELECT count(*) FROM accounting_journal_entries WHERE workspace_id=$1) AS journals`,[ctx.workspaceId])).rows[0];
    const countsBefore=await effectCounts();
    for(const delivery of ['recover-shipment-handoff','repeat-shipment-handoff']){const response=await send(fulfillmentBody,'fulfillments/create',delivery);assert.equal(response.status,202);const result=await require('../helpers/provider-webhook-worker').result(database,response,providers);assert.equal(result.processingStatus,'COMPLETED',JSON.stringify((await database.query('SELECT error_code,error_message FROM connection_webhook_receipts WHERE workspace_id=$1 AND delivery_id=$2',[ctx.workspaceId,delivery])).rows));assert.equal(result.replayed,1);}
    assert.deepEqual(await effectCounts(),countsBefore);
    assert.deepEqual((await database.query("SELECT movement_ids,payload_hash,normalized_payload FROM connector_feed_events WHERE workspace_id=$1 AND external_event_id='shopify-fulfill-1001'",[ctx.workspaceId])).rows[0],effectBefore);
    const shipment=(await database.query('SELECT * FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2',[ctx.workspaceId,mapped.foundry_record_id])).rows;assert.equal(shipment.length,1);assert.equal(shipment[0].tracking_number,'TEST-7001');assert.equal(shipment[0].tracking_url,'https://example.test/tracking/7001');assert.equal(shipment[0].ship_from_location_id,location.id);assert.equal(shipment[0].provider_shipment_id,'7001');assert.equal(shipment[0].status,'SHIPPED');
    const shipping=require('../../src/shipping/postgres-service'),observation=shopify.normalizeWebhook({headers:{'x-shopify-topic':'fulfillments/create','x-shopify-webhook-id':'recovery'},body:JSON.parse(fulfillmentBody)})[0];
    await assert.rejects(shipping.recordProviderFulfillment(database,{workspaceId:'foreign-workspace',actorId:ctx.actorId},{connectorId,effectKey:observation.effectKey,observation:observation.shipmentObservation}));
    await assert.rejects(shipping.recordProviderFulfillment(database,ctx,{connectorId,effectKey:observation.effectKey,observation:{...observation.shipmentObservation,trackingUrl:'javascript:alert(1)'}}));
    await assert.rejects(shipping.recordProviderFulfillment(database,ctx,{connectorId,effectKey:observation.effectKey,observation:{...observation.shipmentObservation,externalOrderId:'2001'}}));
    assert.equal((await send(fulfillmentBody,'fulfillments/create','shopify-fulfill-1001')).status,200);
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),4);
    assert.equal((await send(createBody,'orders/create','shopify-forged','forged')).status,401);

    const secondBody=JSON.stringify(order(1002,1)),secondResponse=await send(secondBody,'orders/create','shopify-create-1002');assert.equal(secondResponse.status,202);await require('../helpers/provider-webhook-worker').result(database,secondResponse,providers);
    const otherLocation=await locations.createLocation(database,ctx,{name:'Other physical warehouse',kind:'warehouse'});
    await database.query(`INSERT INTO connection_mappings(id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,confidence,approved_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,'location','gid://shopify/Location/45',$4,'approved',$5,$6,$6)`,[newId('cmap'),ctx.workspaceId,connectorId,otherLocation.id,ctx.actorId,at]);
    const misplaced=JSON.stringify({id:7001,order_id:1001,location_id:45,line_items:[{id:10011,variant_id:501,quantity:2}]});
    // Completed physical effects may never be relabelled as another location.
    const wrongObservation=shopify.normalizeWebhook({headers:{'x-shopify-topic':'fulfillments/create'},body:JSON.parse(misplaced)})[0];
    await assert.rejects(shipping.recordProviderFulfillment(database,ctx,{connectorId,effectKey:observation.effectKey,observation:wrongObservation.shipmentObservation}),/location/);
    const unallocated=JSON.stringify({id:7002,order_id:1002,location_id:45,line_items:[{id:10021,variant_id:501,quantity:1}]});
    // No other warehouse may be silently substituted when the provider names
    // an explicitly mapped but unallocated physical source.
    const wrongSource=await send(unallocated,'fulfillments/create','wrong-allocated-source');assert.equal(wrongSource.status,202);
    assert.equal((await require('../helpers/provider-webhook-worker').result(database,wrongSource,providers)).processingStatus,'NEEDS_REVIEW');
    assert.match((await database.query("SELECT error_message FROM connection_webhook_receipts WHERE workspace_id=$1 AND delivery_id='wrong-allocated-source'",[ctx.workspaceId])).rows[0].error_message,/stock committed/);
    assert.equal(Number((await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),4);
    const cancelBody=JSON.stringify({...order(1002,1),cancel_reason:'customer',updated_at:`${eventDay}T14:00:00.000Z`});
    const cancelled=await send(cancelBody,'orders/cancelled','shopify-cancel-1002');
    assert.equal(cancelled.status,202);assert.equal((await require('../helpers/provider-webhook-worker').result(database,cancelled,providers)).accepted,1);
    assert.equal((await database.query(`SELECT so.status FROM sales_orders so JOIN connection_mappings m ON m.foundry_record_id=so.id
      WHERE m.workspace_id=$1 AND m.connector_id=$2 AND m.entity_type='sales_order' AND m.external_id='1002'`,
    [ctx.workspaceId,connectorId])).rows[0].status,'CANCELLED');
    const refund=(id,orderId,transactions=[])=>JSON.stringify({id,order_id:orderId,created_at:`${eventDay}T14:00:01.000Z`,transactions,
      refund_line_items:[{id:id*10,quantity:1,restock_type:'cancel',line_item:{variant_id:501,product_id:50,sku:'SHOP-BOTTLE'}}]});
    const zero=await send(refund(8001,1002),'refunds/create','zero-cancel-refund');await require('../helpers/provider-webhook-worker').result(database,zero,providers);
    assert.equal(Number((await database.query("SELECT count(*) AS n FROM connection_issues WHERE workspace_id=$1 AND issue_type='RETURN_REVIEW_REQUIRED' AND status='OPEN'",[ctx.workspaceId])).rows[0].n),0);
    for(const [id,orderId,transactions]of [[8002,1001,[]],[8003,1002,[{kind:'refund',status:'success',amount:'15.00',currency:'USD'}]]]){const response=await send(refund(id,orderId,transactions),'refunds/create','review-refund-'+id);await require('../helpers/provider-webhook-worker').result(database,response,providers);}
    assert.equal(Number((await database.query("SELECT count(*) AS n FROM connection_issues WHERE workspace_id=$1 AND issue_type='RETURN_REVIEW_REQUIRED' AND status='OPEN'",[ctx.workspaceId])).rows[0].n),2);
    legacyObservation=true;const legacy=await send(refund(8004,1002),'refunds/create','old-zero-cancel');await require('../helpers/provider-webhook-worker').result(database,legacy,providers);legacyObservation=false;
    assert.equal(Number((await database.query("SELECT count(*) AS n FROM connection_issues WHERE workspace_id=$1 AND issue_type='RETURN_REVIEW_REQUIRED' AND status='OPEN'",[ctx.workspaceId])).rows[0].n),3);
    const connection=(await database.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,connectorId])).rows[0];
    const reconcile=await require('../../src/commercial/operations').run(database,ctx.workspaceId,{capability:'connections.commerce',provider:'shopify',operation:'catalog_sync',key:'reconcile-old-zero-cancel'},()=>require('../../src/connections/postgres-webhook-inbox').reconcileCancellationObservations(database,connection,signedAdapter));
    assert.equal(reconcile.resolved,1);assert.equal(Number((await database.query("SELECT count(*) AS n FROM connection_issues WHERE workspace_id=$1 AND issue_type='RETURN_REVIEW_REQUIRED' AND status='OPEN'",[ctx.workspaceId])).rows[0].n),2);
    const repeatedLegacy=await send(refund(8004,1002),'refunds/create','new-delivery-old-zero-cancel');await require('../helpers/provider-webhook-worker').result(database,repeatedLegacy,providers);
    assert.equal(Number((await database.query('SELECT count(*) AS n FROM connection_event_conflicts WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0,'New verification evidence must not change the original refund business identity');
    assert.equal(Number((await database.query("SELECT count(*) AS n FROM connection_issues WHERE workspace_id=$1 AND issue_type='RETURN_REVIEW_REQUIRED' AND status='OPEN'",[ctx.workspaceId])).rows[0].n),2);
    assert.equal(Number((await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),4);
    const foreign=await send(JSON.stringify(order(2001,1)),'orders/create','wrong-store-record');assert.equal(foreign.status,202);const foreignResult=await require('../helpers/provider-webhook-worker').result(database,foreign,providers);assert.equal(foreignResult.processingStatus,'NEEDS_REVIEW');assert.equal(Number((await database.query("SELECT count(*) AS n FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='sales_order' AND external_id='2001'",[ctx.workspaceId,connectorId])).rows[0].n),0);
    await page.goto(`${base}/sales/orders/${mapped.foundry_record_id}`);
    assert.match(await page.locator('main').innerText(),/Fulfilled/i);assert.match(await page.locator('main').innerText(),/1 shipment/);await page.goto(`${base}/fulfilment/${shipment[0].id}`);assert.match(await page.locator('main').innerText(),/TEST-7001/);assert.deepEqual(errors,[]);
  });
