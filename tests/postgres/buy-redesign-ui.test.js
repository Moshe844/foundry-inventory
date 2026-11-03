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
const commerce=require('../../src/operations/postgres-commerce');
const workflows=require('../../src/operations/postgres-business-workflows');

test('Buy: purchase orders, one-page PO, receiving, suppliers, what to order and returns',{timeout:400000},async(context)=>{
  const cluster=await startCluster();
  const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-buy-redesign-ui'});
  await migratePostgres(database);
  const app=createPostgresApp({database,env:'test',sessionSecret:'buy-redesign-secret'});
  const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
  const browser=await chromium.launch();
  context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
    await app.locals.sessionStore.close();await database.close();cluster.stop();});
  const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
  page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
  const base=`http://127.0.0.1:${server.address().port}`;
  const today=new Date().toISOString().slice(0,10);
  await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Hendels shoes');
  await page.getByLabel('Your name').fill('Buy Owner');await page.getByLabel('Work email').fill('buy-ui@example.test');
  await page.locator('input[name="password"]').fill('buy-password');if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('buy-password');
  await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
  const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
    JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='buy-ui@example.test'`)).rows[0];
  const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};

  const back=await locations.createLocation(database,ctx,{name:'Back Stockroom',kind:'warehouse'});
  await locations.createLocation(database,ctx,{name:'SWEEP WH <i>Ä</i>',kind:'warehouse'});
  const item=async(name,code)=>(await catalog.createItem(database,ctx,{name,baseCode:code,trackingMode:'quantity',unitLabel:'pair'})).skuIds[0];
  const black9=await item('Air Max 90 / Black 9','AM90-BLACK-9');const white10=await item('Air Max 90 / White 10','AM90-WHITE-10');
  const laces=await item('Laces / Black','LACE-BLK');
  const nike=await commerce.createSupplier(database,ctx,{name:'Nike Wholesale',email:'nike@example.test',defaultLeadTimeDays:10,paymentTerms:'Net 30'});
  const atlas=await commerce.createSupplier(database,ctx,{name:'Atlas Imports'});
  await commerce.createSupplier(database,ctx,{name:'Zeta <i>Ltd</i>'});
  const link=(s,sku,cost)=>commerce.linkSupplierItem(database,ctx,{supplierId:s.id,skuId:sku,purchaseUnit:'pair',unitsPerPurchaseUnit:1,lastUnitCost:cost,isPreferred:true});
  await link(nike,black9,60);await link(nike,white10,80);await link(atlas,laces,2);
  await database.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,notes,created_at,updated_at)
    VALUES('rp_b9',$1,$2,NULL,10,20,0,'manual','test',$3,$3),('rp_l',$1,$4,NULL,20,50,0,'manual','test',$3,$3)`,[ctx.workspaceId,black9,new Date().toISOString(),laces]);
  const open=await workflows.createPurchaseOrder(database,ctx,{supplierId:nike.id,destinationLocationId:back.id,idempotencyKey:'buy-open',
    lines:[{skuId:black9,quantityUnits:4,unitCost:60},{skuId:white10,quantityUnits:2,unitCost:80}]});
  await workflows.approvePurchaseOrder(database,ctx,open.purchaseOrderId,{idempotencyKey:'buy-open-a'});
  await workflows.placePurchaseOrder(database,ctx,open.purchaseOrderId,{idempotencyKey:'buy-open-p'});
  const onHand=async(sku)=>Number((await database.query('SELECT COALESCE(SUM(on_hand),0) AS n FROM balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku])).rows[0].n);

  // 1. Purchase orders: New purchase order is above the fold, and the tab counts add up to All.
  await page.goto(`${base}/purchasing/orders`);
  const newPo=page.locator('[data-ox-new-po]');assert.ok((await newPo.boundingBox()).y+40<900,'New purchase order above the fold');
  const count=async(tab)=>Number(await page.locator(`[data-ox-tab="${tab}"] [data-ox-count]`).innerText());
  assert.equal(await count('all'),(await count('approve'))+(await count('way'))+(await count('pay'))+(await count('done')));
  assert.equal(await page.locator('.ox-subtabs a').allInnerTexts().then((t)=>t.join('|')),'Purchase orders|Receive|Suppliers|What to order|Returns');

  // 2. New purchase order: ?supplier= preselects, a suggestion chip adds a line, totals follow, Create draft sends nothing.
  await page.goto(`${base}/purchasing/orders/new`);
  assert.equal(await page.locator('#ox-supplier-list a').filter({hasText:'Zeta'}).count(),0,'Sweep records stay out of the picker');
  await page.goto(`${base}/purchasing/orders/new?supplier=${nike.id}`);
  assert.match(await page.locator('.ox-chipcard').innerText(),/Nike Wholesale/);
  assert.equal(await page.locator('select[name=destinationLocationId] option').filter({hasText:'SWEEP'}).count(),0);
  await page.locator(`[data-ox-suggest="${black9}"]`).click();
  const line=page.locator(`[data-purchase-line][data-sku="${black9}"]`);assert.equal(await line.isVisible(),true);
  await line.locator('[name^="quantity["]').fill('5');
  await page.waitForFunction(()=>document.querySelector('[data-purchase-total]').textContent==='$300.00');
  await page.locator('[data-ox-po-input]').fill('white');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('[data-purchase-total]').textContent==='$380.00');
  await Promise.all([page.waitForURL(/\/purchasing\/orders\/po_/),page.getByRole('button',{name:'Create draft',exact:true}).click()]);
  const draftId=new URL(page.url()).pathname.split('/').pop();
  assert.match(await page.locator('main').innerText(),/Nothing has been sent to Nike Wholesale\./);
  assert.equal((await database.query('SELECT status FROM purchase_orders WHERE id=$1',[draftId])).rows[0].status,'DRAFT');
  assert.equal(Number((await database.query("SELECT COUNT(*) AS n FROM supplier_communications WHERE purchase_order_id=$1 AND status='SENT'",[draftId])).rows[0].n),0);

  // 3. Approve follows the supplier rule: approved, not sent; then marked sent by hand.
  await Promise.all([page.waitForNavigation(),page.locator('.ox-head').getByRole('button',{name:'Approve',exact:true}).click()]);
  assert.equal((await database.query('SELECT status FROM purchase_orders WHERE id=$1',[draftId])).rows[0].status,'APPROVED');
  assert.equal(Number((await database.query("SELECT COUNT(*) AS n FROM supplier_communications WHERE purchase_order_id=$1 AND status='SENT'",[draftId])).rows[0].n),0);
  await page.locator('.ox-head').getByRole('button',{name:'Mark as sent'}).click();
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Record as sent to supplier'}).click()]);
  assert.equal((await database.query('SELECT status FROM purchase_orders WHERE id=$1',[draftId])).rows[0].status,'ORDERED');

  // 4. Receive: a partial delivery leaves the order open; a damaged line is written off, not sellable; the rest closes it.
  await page.goto(`${base}/purchasing/orders/${open.purchaseOrderId}/receive`);
  const rows=page.locator('[data-ox-rcv-line]');
  await rows.nth(0).locator('[name^="qty_"]').fill('3');await rows.nth(1).getByText('Damaged').click();
  assert.equal(await page.locator('.ox-head [data-ox-rcv-label]').innerText(),'Receive 5 units');
  await Promise.all([page.waitForURL(new RegExp(`/purchasing/orders/${open.purchaseOrderId}$`)),page.locator('.ox-head [data-ox-rcv-label]').click()]);
  assert.equal((await database.query('SELECT status FROM purchase_orders WHERE id=$1',[open.purchaseOrderId])).rows[0].status,'PARTIALLY_RECEIVED');
  assert.equal(await onHand(black9),3);assert.equal(await onHand(white10),0,'Damaged units are not sellable stock');
  await page.locator('.ox-head').getByRole('link',{name:'Receive delivery'}).click();await page.waitForURL(/\/receive$/);
  await Promise.all([page.waitForURL(new RegExp(`/purchasing/orders/${open.purchaseOrderId}$`)),page.locator('.ox-head [data-ox-rcv-label]').click()]);
  assert.equal((await database.query('SELECT status FROM purchase_orders WHERE id=$1',[open.purchaseOrderId])).rows[0].status,'RECEIVED');

  // 5. Bill, then Record payment lowers Still owed.
  await page.locator('.ox-head').getByRole('button',{name:'Add supplier bill'}).click();
  const bill=page.locator('#ox-bill');await bill.getByLabel('Supplier invoice number').fill('NK-1');await bill.locator('[name=issueDate]').fill(today);
  await Promise.all([page.waitForNavigation(),bill.getByRole('button',{name:'Save bill'}).click()]);
  const owed=async()=>(await page.locator('.ox-sum__total b').innerText());assert.equal(await owed(),'$400.00');
  await page.locator('.ox-head').getByRole('button',{name:'Record payment'}).click();
  const pay=page.locator('[data-ox-pay-bill][open]');await pay.getByLabel('Amount actually paid').fill('150.00');await pay.locator('[name=paymentDate]').fill(today);
  await Promise.all([page.waitForNavigation(),pay.getByRole('button',{name:'Record payment'}).click()]);
  assert.equal(await owed(),'$250.00');

  // 6. Cancel with a reason.
  const extra=await workflows.createPurchaseOrder(database,ctx,{supplierId:atlas.id,destinationLocationId:back.id,idempotencyKey:'buy-cancel',lines:[{skuId:laces,quantityUnits:10,unitCost:2}]});
  await page.goto(`${base}/purchasing/orders/${extra.purchaseOrderId}`);
  await page.getByRole('button',{name:'Cancel order'}).click();await page.locator('#ox-cancel-po').getByLabel('Reason for cancelling').fill('Ordered twice');
  await Promise.all([page.waitForNavigation(),page.locator('#ox-cancel-po').getByRole('button',{name:'Cancel order'}).click()]);
  assert.deepEqual((await database.query('SELECT status,cancel_reason FROM purchase_orders WHERE id=$1',[extra.purchaseOrderId])).rows[0],{status:'CANCELLED',cancel_reason:'Ordered twice'});

  // 7. Add supplier side panel saves.
  await page.goto(`${base}/suppliers`);await page.getByRole('button',{name:'Add supplier'}).click();
  const drawer=page.locator('#ox-supplier-drawer');await drawer.getByLabel('Name').fill('Puma Trade');await drawer.getByLabel('Email for purchase orders').fill('puma@example.test');
  await Promise.all([page.waitForURL(/\/suppliers\/sup_/),drawer.getByRole('button',{name:'Save supplier'}).click()]);
  assert.equal((await database.query("SELECT email FROM suppliers WHERE workspace_id=$1 AND name='Puma Trade'",[ctx.workspaceId])).rows[0].email,'puma@example.test');

  // 8. What to order: Create PO makes a draft with the edited quantity, nothing sent.
  await page.goto(`${base}/purchasing`);
  const group=page.locator(`[data-ox-ro-group][data-supplier="${atlas.id}"]`);
  await group.locator(`[name="line[${atlas.id}][${laces}]"]`).fill('45');
  await Promise.all([page.waitForURL(/\/purchasing\/orders\/po_/),group.getByRole('button',{name:/Create a draft PO/}).click()]);
  const reorderPo=(await database.query(`SELECT po.status,l.quantity_units FROM purchase_orders po JOIN purchase_order_lines l ON l.purchase_order_id=po.id WHERE po.id=$1`,[new URL(page.url()).pathname.split('/').pop()])).rows;
  assert.deepEqual(reorderPo.map((row)=>[row.status,Number(row.quantity_units)]),[['DRAFT',45]]);

  // 9. New return from the list: pick the order, choose a line, create it.
  await page.goto(`${base}/supplier-returns`);await page.getByRole('button',{name:'New return'}).click();
  await page.locator('#ox-new-return select[name=po]').selectOption(open.purchaseOrderId);
  await Promise.all([page.waitForURL(/return=1/),page.getByRole('button',{name:'Choose items'}).click()]);
  const ret=page.locator('#ox-return');await ret.locator('input[name^=quantity_]').first().fill('1');await ret.getByLabel('Expected supplier credit').fill('60');
  await Promise.all([page.waitForURL(/\/supplier-returns\/rtv_/),ret.getByRole('button',{name:'Create return'}).click()]);
  assert.match(await page.locator('.ox-head').innerText(),/Requested/);

  // Phone: New purchase order stays above the fold and nothing scrolls sideways.
  await page.setViewportSize({width:390,height:844});
  for(const path of ['/purchasing/orders','/purchasing/orders/new?supplier='+nike.id,`/purchasing/orders/${open.purchaseOrderId}`,'/suppliers','/purchasing','/supplier-returns']){
    await page.goto(base+path);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390,`No sideways scroll on ${path}`);}
  await page.goto(`${base}/purchasing/orders`);assert.ok((await page.locator('[data-ox-new-po]').boundingBox()).y+40<844);
  assert.deepEqual(errors,[]);
});
