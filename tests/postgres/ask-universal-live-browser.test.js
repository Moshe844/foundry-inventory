'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const config=require('../../src/config');
const {createProviderUnobserved}=require('../../src/ai/provider');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');
const commerce=require('../../src/operations/postgres-commerce');
const inventory=require('../../src/domain/postgres-inventory-engine');
const workflows=require('../../src/operations/postgres-business-workflows');
const ledger=require('../../src/accounting/postgres-ledger');
const costing=require('../../src/accounting/postgres-costing');
const imports=require('../../src/imports/postgres-service');
const jobs=require('../../src/operations/postgres-job-queue');
const runtimeHandlers=require('../../src/operations/postgres-runtime-handlers');

test('real model and Chromium select new Ask lifecycle contracts and commit verified PostgreSQL changes',
  {skip:!config.ai.configured,timeout:300000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'ask-universal-live-browser'});
    await migratePostgres(database);
    const rawProvider=createProviderUnobserved(config.ai.provider,config.ai.tier('fast'));
    const transcript=[];
    const app=createPostgresApp({database,env:'test',sessionSecret:'ask-universal-live-secret',
      aiProvider:{...rawProvider,async complete(request){const response=await rawProvider.complete(request);
        transcript.push({schema:request.schemaName,data:response.data});return response;}}});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;const page=await browser.newPage();
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Live Ask Workflow');
    await page.getByLabel('Your name').fill('Live Workflow Owner');
    await page.getByLabel('Work email').fill('live-workflow@example.test');
    await page.getByLabel('Password').fill('ask-live-workflow-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const owner=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id
      FROM workspaces w JOIN users u ON u.workspace_id=w.id AND u.role='owner'
      WHERE w.name='Live Ask Workflow'`)).rows[0];
    const ctx={workspaceId:owner.workspace_id,actorId:owner.actor_id};
    const place=await locations.createLocation(database,ctx,{name:'East Stockroom',kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:'Copper Fixture',trackingMode:'quantity'});
    await ledger.configure(database,ctx,{startDate:'2026-01-01',currency:'USD'});
    const opening=await inventory.receive(database,ctx,{skuId:item.skuIds[0],locationId:place.id,
      quantity:8,idempotencyKey:'live-ask-opening'});
    await database.transaction(async(client)=>{
      const posted=await ledger.postInTransaction(client,ctx,{postingDate:'2026-09-23',sourceKey:'live-ask-opening-cost',
        description:'Opening stock',sourceType:'opening_inventory',sourceRecordType:'movement',
        sourceRecordId:opening.movementId,lines:[{accountKey:'INVENTORY_ASSET',debitMinor:4000},
          {accountKey:'OPENING_BALANCE_EQUITY',creditMinor:4000}]});
      await costing.receiveInTransaction(client,ctx,{movementId:opening.movementId,totalCostMinor:4000,
        journalEntryId:posted.entry.id,sourceType:'opening_inventory',sourceRecordId:opening.movementId});
    },{isolation:'SERIALIZABLE',retrySafe:true});
    const customer=await commerce.createCustomer(database,ctx,{name:'Harbor Renovations',
      email:'harbor@example.test',shippingAddress:'14 Harbor Lane, Boston, MA 02110'});
    const order=await workflows.createSalesOrder(database,ctx,{customerId:customer.id,deliveryMethod:'PICKUP',
      fulfillmentLocationId:place.id,idempotencyKey:'live-ask-order',
      lines:[{skuId:item.skuIds[0],quantity:2,unitPriceMinor:1200}]});
    async function ask(message,expected){
      await page.goto(`${base}/ask`);
      await page.getByLabel('Ask StockChief').fill(message);
      await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue'}).click()]);
      const latest=(await database.query(`SELECT action_type,id,status FROM stockchief_runtime.assistant_action_proposals
        WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
      assert.equal(latest?.action_type,expected,`Ask: ${(await page.locator('main').innerText()).slice(0,1000)}\n`+
        `Model: ${JSON.stringify(transcript.slice(-4)).slice(0,3000)}`);
      assert.equal(latest.status,'PENDING');
      await page.goto(`${base}/actions/${latest.id}`);
      await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve and execute'}).click()]);
      const saved=(await database.query(`SELECT status FROM stockchief_runtime.assistant_action_proposals
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,latest.id])).rows[0];
      assert.equal(saved.status,'EXECUTED',`Approval: ${(await page.locator('body').innerText()).slice(0,1000)}`);
    }
    await ask(`Harbor's ${order.orderNumber} is ready. Confirm it and reserve available units; if stock is short, backorder the rest.`,
      'sales_order.confirm');
    assert.equal((await database.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,order.salesOrderId])).rows[0].status,'CONFIRMED');
    await ask(`The two Copper Fixtures on ${order.orderNumber} were just handed across the counter. Record their fulfillment.`,
      'sales_order.fulfill');
    assert.equal((await database.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,order.salesOrderId])).rows[0].status,'FULFILLED');
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM accounting_customer_invoices
      WHERE workspace_id=$1 AND sales_order_id=$2`,[ctx.workspaceId,order.salesOrderId])).rows[0].count,1);
    await ask('Rename this inventory to Live Ask Operations','workspace.rename');
    assert.equal((await database.query('SELECT name FROM workspaces WHERE id=$1',
      [ctx.workspaceId])).rows[0].name,'Live Ask Operations');
    const quarantine=await locations.createLocation(database,ctx,{name:'Returns Quarantine',kind:'warehouse'});
    await ask(`Harbor returned one Copper Fixture from ${order.orderNumber} because it was cracked. `+
      'Request a no-refund return and put it in Returns Quarantine for inspection.',
    'customer_return.request');
    const returned=(await database.query(`SELECT status,quarantine_location_id FROM customer_returns
      WHERE workspace_id=$1 AND sales_order_id=$2`,[ctx.workspaceId,order.salesOrderId])).rows[0];
    assert.equal(returned.status,'REQUESTED');
    assert.equal(returned.quarantine_location_id,quarantine.id);
    const preview=await imports.analyse(database,ctx,{text:
      'Product,SKU,Location,Quantity\nBrass Coupling,BC-1,East Stockroom,3\n',
    filename:'live-ask-brass.csv'});
    await ask('Approve the reviewed live-ask-brass.csv import preview, but do not apply its rows yet',
      'import.approve');
    assert.equal((await database.query(`SELECT approval_status FROM import_plans WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,preview.id])).rows[0].approval_status,'APPROVED');
    await ask('Now import and verify the approved live-ask-brass.csv preview','import.run');
    const importHandler=runtimeHandlers.create()['import.execute-approved'];
    const done=await jobs.processOne(database,{'import.execute-approved':importHandler},
      {owner:'live-ask-import-worker'});
    assert.equal(done.status,'COMPLETED');
    assert.equal((await database.query(`SELECT status FROM import_plans WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,preview.id])).rows[0].status,'SUCCEEDED');
    await database.query(`UPDATE locations SET barcode='EAST-BIN' WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,place.id]);
    await database.query(`UPDATE skus SET barcode='COPPER-SCAN' WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,item.skuIds[0]]);
    const waveOrder=await workflows.createSalesOrder(database,ctx,{customerId:customer.id,
      deliveryMethod:'PICKUP',fulfillmentLocationId:place.id,idempotencyKey:'live-ask-wave-order',
      lines:[{skuId:item.skuIds[0],quantity:2,unitPriceMinor:1200}]});
    await workflows.confirmSalesOrder(database,ctx,waveOrder.salesOrderId,{idempotencyKey:'live-ask-wave-confirm'});
    await ask(`Release ${waveOrder.orderNumber} as a warehouse picking wave. Do not ship it yet.`,
      'warehouse.wave.create');
    const wave=(await database.query(`SELECT id,title FROM fulfillment_waves WHERE workspace_id=$1
      ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
    assert.ok(wave);
    await ask(`I physically scanned two COPPER-SCAN units at EAST-BIN for the open pick wave ${wave.title}. `+
      'Verify that pick; do not ship.','warehouse.wave.scan');
    assert.equal(Number((await database.query(`SELECT picked_quantity FROM fulfillment_wave_lines
      WHERE workspace_id=$1 AND wave_id=$2`,[ctx.workspaceId,wave.id])).rows[0].picked_quantity),2);
    await ask(`Pack the scan-verified carton for ${wave.title}; measured weight is 700 grams. Do not hand it off.`,
      'warehouse.wave.pack');
    assert.equal((await database.query(`SELECT status FROM fulfillment_waves WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,wave.id])).rows[0].status,'PACKED');
  });
