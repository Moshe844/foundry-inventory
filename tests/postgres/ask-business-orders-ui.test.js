'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const commerce=require('../../src/operations/postgres-commerce');
const pricing=require('../../src/pricing/postgres-service');

function fields(overrides={}){
  return {intent:'lookup',view:'inventory',action:null,search:null,sku:null,location:null,fromLocation:null,toLocation:null,
    quantity:null,countedQuantity:null,amount:null,currency:null,reason:null,reference:null,recipient:'',recipientKind:'',
    subject:'',body:'',mailbox:'',customer:'',supplier:'',deliveryMethod:'',shipToAddress:'',neededBy:'',...overrides};
}

const provider={name:'fixture',model:'fixture',async complete(request){
  const message=JSON.parse(request.prompt).message;
  if(message==='Record the complete customer order')return {data:fields({intent:'action',view:null,action:'create_sales_order',
    customer:'Builder Co',sku:'SHOE-9',quantity:4,deliveryMethod:'SHIP',neededBy:'2026-10-02'}),usage:{}};
  if(message==='Record an order but I forgot the delivery method')return {data:fields({intent:'action',view:null,
    action:'create_sales_order',customer:'Builder Co',sku:'SHOE-9',quantity:2}),usage:{}};
  if(message==='Deliver this order without an address')return {data:fields({intent:'action',view:null,
    action:'create_sales_order',customer:'No Address Buyer',sku:'SHOE-9',quantity:1,deliveryMethod:'OWN_DELIVERY'}),usage:{}};
  if(message==='Buy seventeen pairs from our supplier')return {data:fields({intent:'action',view:null,
    action:'create_purchase_order',supplier:'Safe Supply',sku:'SHOE-9',quantity:17,location:'Main Warehouse',
    amount:8,currency:'USD',neededBy:'2026-10-05'}),usage:{}};
  return {data:fields(),usage:{}};
}};

async function register(page,base,business,email){
  await page.goto(`${base}/register`);await page.getByLabel('Business name').fill(business);
  await page.getByLabel('Your name').fill(`${business} Owner`);await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('ask-orders-password');
  await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
}

async function ask(page,base,message){
  await page.goto(`${base}/ask`);await page.getByLabel('Ask StockChief').fill(message);
  await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
  return page.locator('main').innerText();
}

test('real Chromium Ask StockChief safely prepares and executes grounded customer and supplier orders',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();const database=openPostgres(cluster.connectionString,
      {applicationName:'stockchief-ask-business-orders-ui'});
    await migratePostgres(database);const app=createPostgresApp({database,env:'test',sessionSecret:'ask-orders-secret',
      aiProvider:provider});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();const first=await browser.newContext();const second=await browser.newContext();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;const page=await first.newPage();const other=await second.newPage();
    await register(page,base,'Order Business One','orders-one@example.test');
    await register(other,base,'Order Business Two','orders-two@example.test');
    const identities=(await database.query(`SELECT w.name,w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id AND u.role='owner' WHERE w.name IN ('Order Business One','Order Business Two')`)).rows;
    const one=identities.find((row)=>row.name==='Order Business One');const two=identities.find((row)=>row.name==='Order Business Two');

    await page.goto(`${base}/locations`);await page.getByRole('button',{name:'Add your first location'}).click();
    await page.getByLabel('Name').fill('Main Warehouse');
    await page.getByLabel('Type').selectOption('warehouse');
    await Promise.all([page.waitForNavigation(),page.locator('#modal-location').getByRole('button',{name:'Add location'}).click()]);
    await page.goto(`${base}/inventory/new`);await page.locator('#name').fill('Safety Shoe');
    await page.locator('#baseCode').fill('SHOE');await page.getByLabel(/This item comes in options/).check();
    await page.getByLabel('First option name').fill('Size');await page.getByLabel('First option choices').fill('9');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Create item'}).click()]);
    const sku=(await database.query(`SELECT s.id,s.code FROM skus s JOIN items i ON i.id=s.item_id
      WHERE s.workspace_id=$1 AND i.name='Safety Shoe'`,[one.workspace_id])).rows[0];
    assert.equal(sku.code,'SHOE-9');
    await pricing.setPrice(database,{workspaceId:one.workspace_id,actorId:one.actor_id},
      {skuId:sku.id,amountMinor:1500,currency:'USD'});
    const customer=await commerce.createCustomer(database,{workspaceId:one.workspace_id,actorId:one.actor_id},
      {name:'Builder Co',email:'buyer@example.test',shippingAddress:'10 Jobsite Road'});
    await commerce.createCustomer(database,{workspaceId:one.workspace_id,actorId:one.actor_id},
      {name:'No Address Buyer',email:'no-address@example.test'});
    const supplier=await commerce.createSupplier(database,{workspaceId:one.workspace_id,actorId:one.actor_id},
      {name:'Safe Supply',email:'safe@supplier.example',currency:'USD'});
    await commerce.createCustomer(database,{workspaceId:two.workspace_id,actorId:two.actor_id},
      {name:'Builder Co',email:'wrong@example.test',shippingAddress:'999 Wrong Tenant Road'});
    await commerce.createSupplier(database,{workspaceId:two.workspace_id,actorId:two.actor_id},
      {name:'Safe Supply',email:'wrong-supplier@example.test',currency:'USD'});

    let text=await ask(page,base,'Record an order but I forgot the delivery method');
    assert.match(text,/Should the customer order be shipped, picked up, or delivered by your business/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM sales_orders WHERE workspace_id=$1`,
      [one.workspace_id])).rows[0].count,'0');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1`,[one.workspace_id])).rows[0].count,'0');

    text=await ask(page,base,'Deliver this order without an address');
    assert.match(text,/What is the delivery address for No Address Buyer/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM sales_orders WHERE workspace_id=$1`,
      [one.workspace_id])).rows[0].count,'0');

    text=await ask(page,base,'Record the complete customer order');
    assert.match(text,/Prepare a draft customer order for Builder Co/);assert.match(text,/10 Jobsite Road/);
    assert.match(text,/Nothing has changed yet/);
    assert.doesNotMatch(text,/999 Wrong Tenant Road/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM sales_orders WHERE workspace_id=$1`,
      [one.workspace_id])).rows[0].count,'0');
    let proposalHref=await page.locator('a',{hasText:'Review prepared change'}).last().getAttribute('href');
    await page.goto(`${base}${proposalHref}`);assert.match(await page.locator('main').innerText(),/sales_order\.create/);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve and execute'}).click()]);
    const salesOrder=(await database.query(`SELECT so.*,sol.quantity_ordered,sol.unit_price_minor FROM sales_orders so
      JOIN sales_order_lines sol ON sol.sales_order_id=so.id WHERE so.workspace_id=$1`,[one.workspace_id])).rows[0];
    assert.deepEqual({customer:salesOrder.customer_id,method:salesOrder.delivery_method,address:salesOrder.ship_to_address,
      needed:salesOrder.needed_by,quantity:Number(salesOrder.quantity_ordered),price:Number(salesOrder.unit_price_minor),status:salesOrder.status},
    {customer:customer.id,method:'SHIP',address:'10 Jobsite Road',needed:'2026-10-02',quantity:4,price:1500,status:'DRAFT'});
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM sales_order_allocations WHERE workspace_id=$1`,
      [one.workspace_id])).rows[0].count,'0');
    const salesLink=page.getByRole('link',{name:new RegExp(`Continue ${salesOrder.order_number}`)});assert.equal(await salesLink.count(),1);
    const csrf=await page.locator('input[name="_csrf"]').first().getAttribute('value');
    assert.equal((await page.request.post(`${base}${proposalHref}/approve`,{form:{_csrf:csrf},maxRedirects:0})).status(),303);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM sales_orders WHERE workspace_id=$1`,
      [one.workspace_id])).rows[0].count,'1');
    await salesLink.click();await page.waitForURL(new RegExp(`/orders/${salesOrder.id}$`));
    assert.match(await page.locator('main').innerText(),/Builder Co/);

    text=await ask(page,base,'Buy seventeen pairs from our supplier');
    assert.match(text,/Prepare a draft purchase order to Safe Supply/);assert.match(text,/17 × Safety Shoe/);
    assert.match(text,/Main Warehouse/);assert.match(text,/Nothing has changed yet/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM purchase_orders WHERE workspace_id=$1`,
      [one.workspace_id])).rows[0].count,'0');
    proposalHref=await page.locator('a',{hasText:'Review prepared change'}).last().getAttribute('href');
    await page.goto(`${base}${proposalHref}`);assert.match(await page.locator('main').innerText(),/purchase_order\.create/);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve and execute'}).click()]);
    const purchaseOrder=(await database.query(`SELECT po.*,pol.quantity_units,pol.unit_cost FROM purchase_orders po
      JOIN purchase_order_lines pol ON pol.purchase_order_id=po.id WHERE po.workspace_id=$1`,[one.workspace_id])).rows[0];
    assert.deepEqual({supplier:purchaseOrder.supplier_id,location:purchaseOrder.destination_location_id,
      needed:purchaseOrder.expected_date,quantity:Number(purchaseOrder.quantity_units),cost:Number(purchaseOrder.unit_cost),
      status:purchaseOrder.status},{supplier:supplier.id,location:(await database.query(`SELECT id FROM locations
        WHERE workspace_id=$1 AND name='Main Warehouse'`,[one.workspace_id])).rows[0].id,needed:'2026-10-05',quantity:17,cost:8,status:'DRAFT'});
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM balances WHERE workspace_id=$1`,
      [one.workspace_id])).rows[0].count,'0');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM purchase_orders WHERE workspace_id=$1
      AND status IN ('APPROVED','PLACED','PARTIALLY_RECEIVED')`,[one.workspace_id])).rows[0].count,'0');
    const purchaseLink=page.getByRole('link',{name:new RegExp(`Continue ${purchaseOrder.po_number}`)});assert.equal(await purchaseLink.count(),1);
    const purchaseCsrf=await page.locator('input[name="_csrf"]').first().getAttribute('value');
    assert.equal((await page.request.post(`${base}${proposalHref}/approve`,{form:{_csrf:purchaseCsrf},maxRedirects:0})).status(),303);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM purchase_orders WHERE workspace_id=$1`,
      [one.workspace_id])).rows[0].count,'1');
    await purchaseLink.click();await page.waitForURL(new RegExp(`/purchasing/orders/${purchaseOrder.id}$`));
    assert.match(await page.locator('main').innerText(),/Safe Supply/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM sales_orders WHERE workspace_id=$1`,
      [two.workspace_id])).rows[0].count,'0');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM purchase_orders WHERE workspace_id=$1`,
      [two.workspace_id])).rows[0].count,'0');
  });
