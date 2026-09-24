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
const {newId,nowIso}=require('../../src/lib/util');

test('real Chromium proves native PostgreSQL transfer-versus-buy planning, approval and bounded autonomy',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-autopilot-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-autopilot-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Autopilot UI Business');
    await page.getByLabel('Your name').fill('Autopilot Owner');await page.getByLabel('Work email').fill('autopilot-pg@example.test');
    await page.getByLabel('Password').fill('autopilot-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='autopilot-pg@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const source=await locations.createLocation(database,ctx,{name:'North Warehouse',kind:'warehouse'});
    const destination=await locations.createLocation(database,ctx,{name:'South Store',kind:'store'});
    const transferItem=await catalog.createItem(database,ctx,{name:'Transfer Widget',baseCode:'TW',trackingMode:'quantity',unitLabel:'unit'});
    await inventory.receive(database,ctx,{skuId:transferItem.skuIds[0],locationId:source.id,quantity:40,
      reference:'OPENING-TRANSFER',idempotencyKey:'autopilot-transfer-opening-source'});
    await inventory.receive(database,ctx,{skuId:transferItem.skuIds[0],locationId:destination.id,quantity:2,
      reference:'OPENING-TRANSFER',idempotencyKey:'autopilot-transfer-opening-destination'});
    const at=nowIso();
    await database.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,
      safety_stock,source,created_at,updated_at) VALUES($1,$2,$3,$4,5,12,2,'manual',$5,$5),
      ($6,$2,$3,$7,0,10,10,'manual',$5,$5)`,
    [newId('rpol'),ctx.workspaceId,transferItem.skuIds[0],destination.id,at,newId('rpol'),source.id]);

    await page.goto(`${base}/autopilot`);
    assert.match(await page.locator('main').innerText(),/Decide what StockChief may handle without you/);
    assert.equal(await page.locator('.job').count(),8);
    for(const job of ['Move stock between locations','Reorder and place purchase orders',
      'Keep replenishment levels up to date','Email suppliers','Answer customers','Ask customers to pay',
      'Buy shipping labels','Tell customers their order has shipped']){
      assert.equal(await page.locator('.job').filter({hasText:job}).count(),1,job);
    }
    const paymentAuthority=page.locator('.job').filter({hasText:'Ask customers to pay'});
    await Promise.all([page.waitForNavigation(),paymentAuthority.getByRole('button',{name:'Let StockChief do this'}).click()]);
    assert.match(await page.locator('.job').filter({hasText:'Ask customers to pay'}).innerText(),/Authorised/);
    assert.match(await page.locator('.job').filter({hasText:'Email suppliers'}).innerText(),/Asks first/);
    let grants=(await database.query(`SELECT capability,granted FROM autopilot_capabilities
      WHERE workspace_id=$1 ORDER BY capability`,[ctx.workspaceId])).rows;
    assert.deepEqual(grants.map((row)=>({capability:row.capability,granted:Number(row.granted)})),
      [{capability:'payment_requests',granted:1}]);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Check the operation now'}).click()]);
    assert.match(await page.locator('main').innerText(),/Transfer Widget[\s\S]*waiting for approval/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM work_items WHERE workspace_id=$1
      AND source='postgres_autopilot' AND execution_status='WAITING_FOR_APPROVAL'`,[ctx.workspaceId])).rows[0].count,'1');
    await page.goto(`${base}/needs-you`);assert.match(await page.locator('main').innerText(),/Transfer Widget/);
    await page.getByRole('link',{name:'Review decision'}).click();
    assert.match(await page.locator('main').innerText(),/Move 10 units from North Warehouse to South Store/);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve and execute'}).click()]);
    assert.match(await page.locator('main').innerText(),/Prepared, authorized, and reserved/);
    const transferred=(await database.query(`SELECT location_id,on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2`,
      [ctx.workspaceId,transferItem.skuIds[0]])).rows;
    assert.deepEqual(Object.fromEntries(transferred.map((row)=>[row.location_id,Number(row.on_hand)])),
      {[source.id]:40,[destination.id]:2});
    const preparedTransfer=(await database.query(`SELECT status,source_location_id,destination_location_id
      FROM inventory_transfers WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0];
    assert.deepEqual(preparedTransfer,{status:'APPROVED',source_location_id:source.id,destination_location_id:destination.id});
    assert.match(await page.getByRole('link',{name:/Continue TR-/}).getAttribute('href'),/^\/transfers\/tr_/);

    const purchaseItem=await catalog.createItem(database,ctx,{name:'Purchase Widget',baseCode:'PW',trackingMode:'quantity',unitLabel:'unit'});
    const supplierId=newId('sup');const supplierItemId=newId('supi');
    await database.query(`INSERT INTO suppliers(id,workspace_id,name,status,default_lead_time_days,currency,created_at,updated_at)
      VALUES($1,$2,'Routine Supply','active',7,'USD',$3,$3)`,[supplierId,ctx.workspaceId,at]);
    await database.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,supplier_sku,purchase_unit,
      units_per_purchase_unit,last_unit_cost,lead_time_days,minimum_order_quantity,order_multiple,is_preferred,is_active,created_at,updated_at)
      VALUES($1,$2,$3,$4,'RS-PW','case',12,2.00,7,2,1,1,1,$5,$5)`,
    [supplierItemId,ctx.workspaceId,supplierId,purchaseItem.skuIds[0],at]);
    await database.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,
      safety_stock,preferred_supplier_id,lead_time_days,source,created_at,updated_at)
      VALUES($1,$2,$3,$4,5,20,2,$5,7,'manual',$6,$6)`,
    [newId('rpol'),ctx.workspaceId,purchaseItem.skuIds[0],destination.id,supplierId,at]);

    await page.goto(`${base}/autopilot`);const authority=page.locator('form[action="/autopilot/routine-authority"]');
    await authority.getByLabel('Balance stock between locations').check();
    await authority.getByLabel('Approve routine replenishment').check();
    await authority.getByLabel('Most units in one automatic transfer').fill('25');
    await authority.getByLabel('Most per purchase order ($)').fill('100');
    await authority.getByLabel('Most across seven days ($)').fill('500');
    await authority.getByLabel('Routine Supply').check();
    await Promise.all([page.waitForNavigation(),authority.getByRole('button',{name:'Confirm these limits'}).click()]);
    assert.equal(await page.getByLabel('Handle routine work').isChecked(),true);
    assert.equal(await page.getByLabel('Approve routine replenishment').isChecked(),true);
    grants=(await database.query(`SELECT capability,granted FROM autopilot_capabilities
      WHERE workspace_id=$1 AND granted=1 ORDER BY capability`,[ctx.workspaceId])).rows;
    assert.deepEqual(grants.map((row)=>row.capability),['inventory_transfers','payment_requests','replenishment']);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Check the operation now'}).click()]);
    assert.match(await page.locator('main').innerText(),/Purchase Widget[\s\S]*completed/);
    const order=(await database.query(`SELECT po.status,pol.quantity_units,pol.quantity_purchase_units,pol.units_per_purchase_unit,
      po.source FROM purchase_orders po JOIN purchase_order_lines pol ON pol.purchase_order_id=po.id
      WHERE po.workspace_id=$1 AND po.source='foundry_recommendation'`,[ctx.workspaceId])).rows[0];
    assert.deepEqual({status:order.status,units:Number(order.quantity_units),purchaseUnits:Number(order.quantity_purchase_units),
      pack:Number(order.units_per_purchase_unit),source:order.source},
    {status:'APPROVED',units:24,purchaseUnits:2,pack:12,source:'foundry_recommendation'});
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM work_items WHERE workspace_id=$1
      AND source='postgres_autopilot' AND execution_status='COMPLETED'`,[ctx.workspaceId])).rows[0].count,'2');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM inventory_transfers WHERE workspace_id=$1`,
      [ctx.workspaceId])).rows[0].count,'1');
    assert.deepEqual(errors,[]);
  });
