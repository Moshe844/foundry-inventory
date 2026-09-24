'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const locations=require('../../src/domain/postgres-location-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const costing=require('../../src/accounting/postgres-costing');
const commerce=require('../../src/operations/postgres-commerce');
const workflows=require('../../src/operations/postgres-business-workflows');
const shipping=require('../../src/shipping/postgres-service');

test('real Chromium runs a PostgreSQL fulfillment wave without moving stock before physical handoff',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-warehouse-waves'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-warehouse-wave-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Wave Business');
    await page.getByLabel('Your name').fill('Wave Owner');await page.getByLabel('Work email').fill('wave-owner@example.test');
    await page.getByLabel('Password').fill('wave-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT workspace.id AS workspace_id,user_record.id AS actor_id
      FROM workspaces workspace JOIN users user_record ON user_record.workspace_id=workspace.id
      JOIN accounts account ON account.id=user_record.account_id WHERE account.email='wave-owner@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const location=await locations.createLocation(database,ctx,{name:'Wave Bin A',kind:'warehouse',barcode:'BIN-A',
      address:'10 Warehouse Way, Albany, NY 12207',phone:'518-555-0100'});
    const item=await catalog.createItem(database,ctx,{name:'Wave Widget',baseCode:'WAVE-1',trackingMode:'quantity',unitLabel:'unit'});
    await database.query('UPDATE skus SET barcode=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,item.skuIds[0],'ITEM-A']);
    const opening=await inventory.receive(database,ctx,{skuId:item.skuIds[0],locationId:location.id,quantity:5,
      reference:'WAVE-OPENING',idempotencyKey:'wave-opening'});
    await database.transaction((client)=>costing.receiveInTransaction(client,ctx,{
      movementId:opening.movementId,unitCostMinor:1000,sourceType:'opening_inventory',sourceRecordId:opening.movementId
    }));
    const customer=await commerce.createCustomer(database,ctx,{name:'Wave Customer',email:'wave-customer@example.test',
      shippingAddress:'20 Customer Road, Albany, NY 12207'});
    const created=await workflows.createSalesOrder(database,ctx,{customerId:customer.id,orderDate:'2026-09-23',
      neededBy:'2026-09-24',fulfillmentLocationId:location.id,deliveryMethod:'SHIP',
      shipToAddress:'20 Customer Road, Albany, NY 12207',currency:'USD',idempotencyKey:'wave-order-create',
      lines:[{skuId:item.skuIds[0],quantity:2,unitPriceMinor:2500}]});
    await workflows.confirmSalesOrder(database,ctx,created.salesOrderId,{idempotencyKey:'wave-order-confirm'});
    await page.goto(`${base}/warehouse/operations`);
    assert.match(await page.locator('main').innerText(),/SO-00001 · Wave Customer · 2 units/);
    await page.getByLabel(/SO-00001 · Wave Customer/).check();
    await Promise.all([page.waitForURL(/\/warehouse\/waves\/wave_/),page.getByRole('button',{name:'Release wave'}).click()]);
    assert.match(await page.locator('main').innerText(),/Wave released/);
    assert.match(await page.locator('main').innerText(),/0 of 2 scan-verified/);
    let balance=await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
      [ctx.workspaceId,item.skuIds[0],location.id]);
    assert.equal(Number(balance.rows[0].on_hand),5);
    await page.getByLabel('Location scan').fill('WRONG-BIN');await page.getByLabel('Product scan').fill('ITEM-A');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Verify pick'}).click()]);
    assert.match(await page.locator('main').innerText(),/did not match exactly one active record/);
    assert.match(await page.locator('main').innerText(),/BLOCKED/);
    balance=await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
      [ctx.workspaceId,item.skuIds[0],location.id]);
    assert.equal(Number(balance.rows[0].on_hand),5);
    await page.getByLabel('Location scan').fill('BIN-A');await page.getByLabel('Product scan').fill('ITEM-A');
    await page.getByLabel('Quantity').fill('2');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Verify pick'}).click()]);
    assert.match(await page.locator('main').innerText(),/Verified 2 Wave Widget from Wave Bin A/);
    assert.match(await page.locator('main').innerText(),/2 of 2 scan-verified/);
    await page.getByLabel('Measured weight in grams').fill('900');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Pack'}).click()]);
    assert.match(await page.locator('main').innerText(),/Carton packed. No stock moved/);
    const shipment=(await database.query(`SELECT * FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2`,
      [ctx.workspaceId,created.salesOrderId])).rows[0];
    assert.equal(shipment.status,'PACKED');assert.equal(Number(shipment.weight_grams),900);
    balance=await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
      [ctx.workspaceId,item.skuIds[0],location.id]);
    assert.equal(Number(balance.rows[0].on_hand),5);
    assert.equal((await database.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,created.salesOrderId])).rows[0].status,'CONFIRMED');
    await database.query(`UPDATE sales_shipments SET label_status='PURCHASED',tracking_number='TRACK-WAVE-1',
      label_url='https://labels.example.test/wave.pdf',updated_at=now()::text WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,shipment.id]);
    await shipping.handoff(database,ctx,shipment.id,{idempotencyKey:'wave-handoff'});
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Verify shipment outcomes'}).click()]);
    assert.match(await page.locator('main').innerText(),/wave is complete/i);
    assert.match(await page.locator('main').innerText(),/COMPLETED/);
    balance=await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
      [ctx.workspaceId,item.skuIds[0],location.id]);
    assert.equal(Number(balance.rows[0].on_hand),3);
    assert.equal((await database.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,created.salesOrderId])).rows[0].status,'FULFILLED');
    assert.deepEqual(errors,[]);
  });
