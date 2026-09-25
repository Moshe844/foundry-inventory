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

test('real Chromium runs PostgreSQL purchasing, receiving, supplier money, customer orders and payment as one story',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-commerce-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-commerce-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Commerce UI Business');
    await page.getByLabel('Your name').fill('Commerce Owner');await page.getByLabel('Work email').fill('commerce-ui@example.test');
    await page.getByLabel('Password').fill('commerce-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='commerce-ui@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const location=await locations.createLocation(database,ctx,{name:'Commerce Warehouse',kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:'Commerce Boot',baseCode:'BOOT',trackingMode:'quantity',unitLabel:'pair'});

    await page.goto(`${base}/suppliers`);
    await page.getByText('Add a supplier',{exact:true}).first().click();
    const supplierForm=page.locator('details').filter({hasText:'Add a supplier'});
    await supplierForm.getByLabel('Name').fill('Boot Supply');await supplierForm.getByLabel('Email').fill('orders@boots.test');
    await Promise.all([page.waitForNavigation(),supplierForm.getByRole('button',{name:'Create supplier and continue'}).click()]);
    assert.match(page.url(),/\/suppliers\/sup_/);
    const supplierPageText=await page.locator('main').innerText();
    assert.match(supplierPageText,/Boot Supply/);assert.match(supplierPageText,/Supplier setup/i);
    await page.locator('select[name="skuId"]').selectOption(item.skuIds[0]);
    await page.getByLabel('Supplier code').fill('SUP-BOOT-1');
    await page.getByLabel('How many per pack').fill('2');
    await page.getByLabel('Cost per unit').fill('8.00');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Link product'}).click()]);
    assert.match(await page.locator('main').innerText(),/SUP-BOOT-1/);
    await page.goto(`${base}/purchasing`);
    await page.getByText('Add a supplier',{exact:true}).click();
    const quickSupplier=page.locator('#suppliers details').filter({hasText:'Add a supplier'});
    const supplierInputWidths=await quickSupplier.locator('input[name="name"], input[name="email"]').evaluateAll(
      (inputs)=>inputs.map((input)=>Math.round(input.getBoundingClientRect().width)));
    assert.equal(supplierInputWidths.length,2);
    assert.ok(supplierInputWidths.every((width)=>width>300),`Supplier form controls were ${supplierInputWidths.join(', ')}px wide.`);
    assert.ok(Math.abs(supplierInputWidths[0]-supplierInputWidths[1])<=2,'Supplier form columns must align.');
    await page.setViewportSize({width:753,height:900});
    const compactSupplierWidths=await quickSupplier.locator('input[name="name"], input[name="email"], input[name="currency"]').evaluateAll(
      (inputs)=>inputs.map((input)=>Math.round(input.getBoundingClientRect().width)));
    assert.ok(compactSupplierWidths.every((width)=>width>600),`Compact supplier controls were ${compactSupplierWidths.join(', ')}px wide.`);
    await page.setViewportSize({width:1440,height:1000});
    await page.getByLabel('Supplier').selectOption({label:'Boot Supply'});
    await page.getByLabel('Product / SKU').selectOption(item.skuIds[0]);
    await page.getByLabel('Destination').selectOption(location.id);await page.getByLabel('Units').fill('10');
    await page.getByLabel('Cost per inventory unit').fill('8.00');
    await Promise.all([page.waitForURL(/\/purchasing\/orders\/po_/),page.getByRole('button',{name:'Prepare purchase order'}).click()]);
    const purchaseOrderId=page.url().split('/').pop();
    assert.match(await page.locator('main').innerText(),/Nothing has been sent to Boot Supply/);
    assert.equal((await database.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,purchaseOrderId])).rows[0].status,'DRAFT');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve order'}).click()]);
    assert.match(await page.locator('main').innerText(),/has not been sent yet/);
    await page.getByLabel('Supplier confirmation').fill('SUP-PO-1');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Record as sent to supplier'}).click()]);
    assert.match(await page.locator('main').innerText(),/on-hand stock did not/i);
    await page.goto(`${base}/purchasing/orders`);
    assert.match(await page.locator('main').innerText(),/Boot Supply/);
    assert.match(await page.locator('main').innerText(),/PO-00001/);
    await page.goto(`${base}/purchasing/receive`);
    assert.match(await page.locator('main').innerText(),/Book in a delivery/);
    await Promise.all([page.waitForURL(new RegExp(`/purchasing/orders/${purchaseOrderId}/receive$`)),
      page.getByRole('link',{name:'Receive'}).click()]);
    assert.match(await page.locator('main').innerText(),/Arrived \(pairs\)/);
    await page.getByLabel('Arrived (pairs)').fill('10');await page.getByLabel('Delivery note or reference').fill('DOCK-1');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Book it in'}).click()]);
    assert.match(await page.locator('main').innerText(),/Physical receipt recorded through the inventory ledger/);
    assert.equal(Number((await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
      [ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),10);

    await page.getByText('Record a supplier invoice',{exact:true}).click();
    await page.getByLabel('Supplier invoice number').fill('SUP-INV-1');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Record invoice, not receipt'}).click()]);
    assert.match(await page.locator('main').innerText(),/without receiving stock again/);
    assert.equal(Number((await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
      [ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),10);
    await page.locator('summary').filter({hasText:'Record payment'}).click();
    await page.getByLabel('Amount actually paid').fill('30.00');await page.getByLabel('Reference').fill('ACH');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Record payment'}).click()]);
    assert.match(await page.locator('main').innerText(),/payment reduces only the bill/i);
    assert.equal(Number((await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
      [ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),10);

    await page.goto(`${base}/purchasing/setup`);
    assert.match(await page.locator('main').innerText(),/Set up purchasing/);
    assert.match(await page.locator('main').innerText(),/Commerce Boot/);

    await page.goto(`${base}/orders`);await page.getByText('Add a customer',{exact:true}).click();
    const customerForm=page.locator('details').filter({hasText:'Add a customer'});
    const customerInputWidths=await customerForm.locator('input[name="name"], input[name="email"]').evaluateAll(
      (inputs)=>inputs.map((input)=>Math.round(input.getBoundingClientRect().width)));
    assert.equal(customerInputWidths.length,2);
    assert.ok(customerInputWidths.every((width)=>width>300),`Customer form controls were ${customerInputWidths.join(', ')}px wide.`);
    assert.ok(Math.abs(customerInputWidths[0]-customerInputWidths[1])<=2,'Customer form columns must align.');
    await customerForm.getByLabel('Name').fill('Pickup Customer');await customerForm.getByLabel('Email').fill('pickup@example.test');
    await Promise.all([page.waitForNavigation(),customerForm.getByRole('button',{name:'Add customer'}).click()]);
    await page.getByLabel('Customer',{exact:true}).selectOption({label:'Pickup Customer'});
    await page.getByLabel('Product / SKU').selectOption(item.skuIds[0]);await page.getByLabel('Quantity').fill('4');
    await page.getByLabel('Selling price').fill('15.00');await page.getByLabel('Delivery method').selectOption('PICKUP');
    await page.getByLabel('Fulfillment location').selectOption(location.id);
    await Promise.all([page.waitForURL(/\/orders\/so_/),page.getByRole('button',{name:'Draft customer order'}).click()]);
    const salesOrderId=page.url().split('/').pop();
    assert.match(await page.locator('main').innerText(),/Stock is not committed until confirmation/);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Confirm order and reserve stock'}).click()]);
    assert.equal(Number((await database.query(`SELECT COALESCE(SUM(a.quantity),0) AS quantity FROM sales_order_allocations a
      JOIN sales_order_lines l ON l.id=a.sales_order_line_id WHERE l.sales_order_id=$1`,[salesOrderId])).rows[0].quantity),4);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Record these goods as gone'}).click()]);
    assert.match(await page.locator('main').innerText(),/Inventory, revenue, COGS and the customer invoice changed together/);
    assert.equal(Number((await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
      [ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),6);
    await page.locator('details#money > summary').click();
    await page.getByText('Record another payment — cash, cheque, transfer, card machine',{exact:true}).click();
    await page.getByLabel('How much').fill('60.00');await page.locator('select[name="method"]').selectOption('card');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Record this payment'}).click()]);
    const state=(await database.query(`SELECT so.status AS order_status,i.status AS invoice_status,i.balance_minor,
        b.status AS bill_status,b.balance_minor AS bill_balance
      FROM sales_orders so JOIN accounting_customer_invoices i ON i.sales_order_id=so.id
      JOIN purchase_orders po ON po.id=$2 JOIN accounting_supplier_bills b ON b.purchase_order_id=po.id
      WHERE so.id=$1`,[salesOrderId,purchaseOrderId])).rows[0];
    assert.deepEqual({order:state.order_status,invoice:state.invoice_status,customerBalance:Number(state.balance_minor),
      bill:state.bill_status,supplierBalance:Number(state.bill_balance)},
    {order:'FULFILLED',invoice:'PAID',customerBalance:0,bill:'PARTIALLY_PAID',supplierBalance:5000});
    const unbalanced=await database.query(`SELECT e.id FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.entry_id=e.id
      WHERE e.workspace_id=$1 GROUP BY e.id HAVING SUM(l.debit_minor)<>SUM(l.credit_minor)`,[ctx.workspaceId]);
    assert.equal(unbalanced.rows.length,0);assert.deepEqual(errors,[]);
  });
