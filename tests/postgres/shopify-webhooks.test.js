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
const signedAdapter={...shopify,verifyWebhook({headers,rawBody}){
  const expected=crypto.createHmac('sha256',webhookSecret).update(rawBody).digest('base64');
  if(headers['x-shopify-hmac-sha256']!==expected)throw new AuthenticationError('This webhook did not pass Shopify signature verification.');
}};
const providers={get(type){return type==='shopify'?signedAdapter:null;},catalog(){return [];}};
const sign=(body)=>crypto.createHmac('sha256',webhookSecret).update(body).digest('base64');

test('real Chromium qualifies signed Shopify order creation, fulfillment and cancellation on PostgreSQL',
  {timeout:180000},async(context)=>{
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
    await page.getByLabel('Password').fill('shopify-webhook-password');
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
      'x-shopify-topic':topic,'x-shopify-webhook-id':delivery,'x-shopify-hmac-sha256':token},body});
    const order=(id,quantity=2)=>({id,name:`#${id}`,created_at:`${eventDay}T12:00:00.000Z`,updated_at:`${eventDay}T12:00:00.000Z`,
      currency:'USD',location_id:44,email:`buyer-${id}@example.test`,customer:{id:77,first_name:'Sharon',last_name:'Buyer',
        email:`buyer-${id}@example.test`},shipping_address:{address1:'20 Main Street',city:'Monroe',province:'NY',zip:'10950',country_code:'US'},
      line_items:[{variant_id:501,product_id:50,sku:'SHOP-BOTTLE',quantity,price:'15.00'}]});
    const createBody=JSON.stringify(order(1001));
    const created=await send(createBody,'orders/create','shopify-create-1001');
    assert.equal(created.status,200,await created.clone().text());assert.equal((await created.json()).accepted,1);
    const mapped=(await database.query(`SELECT foundry_record_id FROM connection_mappings WHERE workspace_id=$1
      AND connector_id=$2 AND entity_type='sales_order' AND external_id='1001'`,[ctx.workspaceId,connectorId])).rows[0];
    assert.ok(mapped);
    const fulfillmentBody=JSON.stringify({id:7001,order_id:1001,location_id:44,created_at:`${eventDay}T13:00:00.000Z`,
      updated_at:`${eventDay}T13:00:00.000Z`,line_items:[{variant_id:501,product_id:50,sku:'SHOP-BOTTLE',quantity:2}]});
    const fulfilled=await send(fulfillmentBody,'fulfillments/create','shopify-fulfill-1001');
    assert.equal(fulfilled.status,200);assert.equal((await fulfilled.json()).accepted,1);
    assert.equal((await database.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,mapped.foundry_record_id])).rows[0].status,'FULFILLED');
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),4);
    assert.equal((await send(fulfillmentBody,'fulfillments/create','shopify-fulfill-1001')).status,200);
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),4);
    assert.equal((await send(createBody,'orders/create','shopify-forged','forged')).status,401);

    const secondBody=JSON.stringify(order(1002,1));assert.equal((await send(secondBody,'orders/create','shopify-create-1002')).status,200);
    const cancelBody=JSON.stringify({...order(1002,1),cancel_reason:'customer',updated_at:`${eventDay}T14:00:00.000Z`});
    const cancelled=await send(cancelBody,'orders/cancelled','shopify-cancel-1002');
    assert.equal(cancelled.status,200);assert.equal((await cancelled.json()).accepted,1);
    assert.equal((await database.query(`SELECT so.status FROM sales_orders so JOIN connection_mappings m ON m.foundry_record_id=so.id
      WHERE m.workspace_id=$1 AND m.connector_id=$2 AND m.entity_type='sales_order' AND m.external_id='1002'`,
    [ctx.workspaceId,connectorId])).rows[0].status,'CANCELLED');
    await page.goto(`${base}/sales/orders/${mapped.foundry_record_id}`);
    assert.match(await page.locator('main').innerText(),/Fulfilled/i);assert.deepEqual(errors,[]);
  });
