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
const {newId,nowIso}=require('../../src/lib/util');

const sign=(secret,body)=>crypto.createHmac('sha256',secret).update(body).digest('base64');

test('real Chromium qualifies signed WooCommerce create, snapshot fulfillment and cancellation on PostgreSQL',
  {timeout:180000},async(context)=>{
    const eventDay=new Date().toISOString().slice(0,10);
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-woocommerce-webhooks'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-woocommerce-webhook-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Woo Webhook Business');
    await page.getByLabel('Your name').fill('Woo Owner');await page.getByLabel('Work email').fill('woo-webhook@example.test');
    await page.getByLabel('Password').fill('woo-webhook-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='woo-webhook@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const location=await locations.createLocation(database,ctx,{name:'Woo Warehouse',kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:'Woo Mug',baseCode:'WOO-MUG',trackingMode:'quantity',unitLabel:'unit'});
    const received=await inventory.receive(database,ctx,{skuId:item.skuIds[0],locationId:location.id,quantity:8,
      reference:'OPENING',idempotencyKey:'woo-webhook-opening'});
    await database.transaction((client)=>costing.receiveInTransaction(client,ctx,{movementId:received.movementId,
      unitCostMinor:400,sourceType:'opening_inventory',sourceRecordId:received.movementId}));
    const connectorId=newId('con');const at=nowIso();const webhookSecret='woocommerce-webhook-secret';
    const storeUrl='https://woo.example.test';
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,
       expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
      VALUES($1,$2,$3,'Woo Store','woocommerce','connected','["WEBHOOKS"]','["customer orders","fulfillment"]',$4,
        5,'CONNECTED',$5,$6,'Woo test store',$7,$7)`,
    [connectorId,ctx.workspaceId,`woocommerce:${connectorId}`,JSON.stringify({storeUrl}),ctx.actorId,storeUrl,at]);
    await credentialStore.put(database,ctx.workspaceId,connectorId,'provider',{storeUrl,webhookSecret,
      consumerKey:'encrypted-key',consumerSecret:'encrypted-secret'});
    for(const [entityType,externalId,foundryRecordId] of [
      ['sku','501',item.skuIds[0]],['location',storeUrl,location.id],
    ])await database.query(`INSERT INTO connection_mappings
      (id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,confidence,approved_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'approved',$7,$8,$8)`,
    [newId('cmap'),ctx.workspaceId,connectorId,entityType,externalId,foundryRecordId,ctx.actorId,at]);
    const endpoint=`${base}/api/v1/connections/woocommerce/webhooks/${connectorId}`;
    const order=(id,status,quantity=2)=>({id,number:`WEB-${id}`,status,currency:'USD',customer_id:77,
      date_created_gmt:`${eventDay}T12:00:00.000Z`,date_modified_gmt:`${eventDay}T12:00:00.000Z`,
      billing:{first_name:'Wendy',last_name:'Buyer',email:`wendy-${id}@example.test`},
      shipping:{address_1:'10 Main Street',city:'Monroe',state:'NY',postcode:'10950',country:'US'},
      line_items:[{product_id:501,variation_id:0,sku:'WOO-MUG',quantity,price:'10.00'}]});
    const send=async(body,topic,delivery,token=sign(webhookSecret,body))=>fetch(endpoint,{method:'POST',headers:{
      'content-type':'application/json','x-wc-webhook-topic':topic,'x-wc-webhook-delivery-id':delivery,
      'x-wc-webhook-signature':token},body});

    const createdBody=JSON.stringify(order(9001,'processing'));
    const created=await send(createdBody,'order.created','woo-delivery-create-9001');
    assert.equal(created.status,200,await created.clone().text());assert.equal((await created.json()).accepted,1);
    const mapped=(await database.query(`SELECT foundry_record_id FROM connection_mappings WHERE workspace_id=$1
      AND connector_id=$2 AND entity_type='sales_order' AND external_id='9001'`,[ctx.workspaceId,connectorId])).rows[0];
    assert.ok(mapped);
    let salesOrder=(await database.query('SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,mapped.foundry_record_id])).rows[0];
    assert.equal(salesOrder.status,'CONFIRMED');
    assert.equal((await database.query(`SELECT COALESCE(SUM(quantity),0) AS count FROM sales_order_allocations
      WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0].count,'2');
    const replay=await send(createdBody,'order.created','woo-delivery-create-9001');
    assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,1);
    const forged=await send(createdBody,'order.created','woo-delivery-forged','forged');assert.equal(forged.status,401);

    const fulfilledBody=JSON.stringify({...order(9001,'completed'),date_modified_gmt:`${eventDay}T13:00:00.000Z`,
      date_completed_gmt:`${eventDay}T13:00:00.000Z`});
    const fulfilled=await send(fulfilledBody,'order.updated','woo-delivery-fulfilled-9001');
    assert.equal(fulfilled.status,200);assert.equal((await fulfilled.json()).accepted,2);
    salesOrder=(await database.query('SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,mapped.foundry_record_id])).rows[0];
    assert.equal(salesOrder.status,'FULFILLED');
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),6);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM accounting_customer_invoices
      WHERE workspace_id=$1 AND sales_order_id=$2`,[ctx.workspaceId,salesOrder.id])).rows[0].count,'1');

    const secondBody=JSON.stringify(order(9002,'processing',1));
    assert.equal((await send(secondBody,'order.created','woo-delivery-create-9002')).status,200);
    const cancelledBody=JSON.stringify({...order(9002,'cancelled',1),date_modified_gmt:`${eventDay}T14:00:00.000Z`});
    const cancelled=await send(cancelledBody,'order.updated','woo-delivery-cancel-9002');
    assert.equal(cancelled.status,200);assert.equal((await cancelled.json()).accepted,1);
    const cancelledOrder=(await database.query(`SELECT so.* FROM sales_orders so JOIN connection_mappings m
      ON m.foundry_record_id=so.id WHERE m.workspace_id=$1 AND m.connector_id=$2 AND m.entity_type='sales_order'
        AND m.external_id='9002'`,[ctx.workspaceId,connectorId])).rows[0];
    assert.equal(cancelledOrder.status,'CANCELLED');
    assert.equal((await database.query(`SELECT COALESCE(SUM(a.quantity),0) AS count FROM sales_order_allocations a
      JOIN sales_order_lines l ON l.id=a.sales_order_line_id WHERE l.workspace_id=$1 AND l.sales_order_id=$2`,
    [ctx.workspaceId,cancelledOrder.id])).rows[0].count,'0');

    await page.goto(`${base}/sales/orders/${salesOrder.id}`);
    const main=await page.locator('main').innerText();assert.match(main,/WEB-9001/);assert.match(main,/Fulfilled/i);
    assert.deepEqual(errors,[]);
  });
