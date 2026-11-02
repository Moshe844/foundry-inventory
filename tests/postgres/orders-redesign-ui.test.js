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
const pricing=require('../../src/pricing/postgres-service');
const commerce=require('../../src/operations/postgres-commerce');
const workflows=require('../../src/operations/postgres-business-workflows');

test('Orders list and New order: one primary action, tabs that add up, a one-page form with a live total',
  {timeout:300000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-orders-redesign-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'orders-redesign-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Hendels shoes');
    await page.getByLabel('Your name').fill('Orders Owner');await page.getByLabel('Work email').fill('orders-ui@example.test');
    await page.locator('input[name="password"]').fill('orders-password');if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('orders-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='orders-ui@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};

    const store=await locations.createLocation(database,ctx,{name:'Brooklyn Store',kind:'store'});
    await locations.createLocation(database,ctx,{name:'SWEEP WH <i>Ä</i>',kind:'warehouse'});
    const boot=await catalog.createItem(database,ctx,{name:'Air Max 90 / Black 9',baseCode:'AM90-BLACK-9',trackingMode:'quantity',unitLabel:'pair'});
    const samba=await catalog.createItem(database,ctx,{name:'Samba OG / White 9',baseCode:'SAMBA-WHI-9',trackingMode:'quantity',unitLabel:'pair'});
    await database.transaction((client)=>pricing.setPriceInTransaction(client,ctx,{skuId:boot.skuIds[0],amountMinor:13000,currency:'USD'}));
    await database.transaction((client)=>pricing.setPriceInTransaction(client,ctx,{skuId:samba.skuIds[0],amountMinor:10000,currency:'USD'}));
    const supplier=await commerce.createSupplier(database,ctx,{name:'Shoe Supply',email:'supply@example.test'});
    const po=await workflows.createPurchaseOrder(database,ctx,{supplierId:supplier.id,destinationLocationId:store.id,idempotencyKey:'or-po',
      lines:[{skuId:boot.skuIds[0],quantityUnits:20,unitCost:50},{skuId:samba.skuIds[0],quantityUnits:2,unitCost:40}]});
    await workflows.approvePurchaseOrder(database,ctx,po.purchaseOrderId,{idempotencyKey:'or-ap'});
    await workflows.placePurchaseOrder(database,ctx,po.purchaseOrderId,{idempotencyKey:'or-pl'});
    await workflows.receivePurchaseOrder(database,ctx,po.purchaseOrderId,{idempotencyKey:'or-rc',reference:'OR',
      lines:[{lineId:po.lineIds[0],quantity:20,locationId:store.id},{lineId:po.lineIds[1],quantity:2,locationId:store.id}]});
    const sarah=await commerce.createCustomer(database,ctx,{name:'Sarah Klein',email:'sarah@example.test',phone:'718-555-0123',
      shippingAddress:'120 Lee Ave, Brooklyn, NY 11211'});
    await commerce.createCustomer(database,ctx,{name:"José O'Brien & Co. <b>Sweep</b>",email:'ob@example.test'});
    const order=async(key,status)=>{const created=await workflows.createSalesOrder(database,ctx,{customerId:sarah.id,deliveryMethod:'PICKUP',
      fulfillmentLocationId:store.id,idempotencyKey:`or-${key}`,lines:[{skuId:boot.skuIds[0],quantity:1,unitPriceMinor:13000}]});
      if(status!=='DRAFT')await workflows.confirmSalesOrder(database,ctx,created.salesOrderId,{idempotencyKey:`or-c-${key}`});
      if(status==='FULFILLED')await workflows.fulfillSalesOrder(database,ctx,created.salesOrderId,{idempotencyKey:`or-f-${key}`,
        lines:[{lineId:created.lineIds[0],locationId:store.id,quantity:1}]});
      return created;};
    await order('delivered','FULFILLED');const ready=await order('ready','CONFIRMED');const draft=await order('draft','DRAFT');

    // 1. New order is the one primary action, above the fold on desktop and phone.
    for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
      await page.setViewportSize(viewport);await page.goto(`${base}/orders`);
      const box=await page.getByRole('link',{name:'New order',exact:true}).first().boundingBox();
      assert.ok(box&&box.y+box.height<=viewport.height,`New order must be visible without scrolling at ${viewport.width}px`);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,
        `/orders must not scroll sideways at ${viewport.width}px`);
    }
    await page.setViewportSize({width:1440,height:900});await page.goto(`${base}/orders`);
    const main=await page.locator('main').innerText();
    for(const removed of ['Create a customer order','Add a customer manually','Full customer order form','Pricing and promotions',
      'Money customers owe','Ask about your orders','Back to Home'])assert.doesNotMatch(main,new RegExp(removed));

    // 2. Status tabs are exclusive buckets that add up to All, and filter through the URL.
    const counts=Object.fromEntries(await page.locator('[data-ox-tab]').evaluateAll((tabs)=>tabs.map((tab)=>
      [tab.getAttribute('data-ox-tab'),Number(tab.querySelector('[data-ox-count]').textContent)])));
    assert.deepEqual(counts,{all:3,needs:1,ship:1,unpaid:1,done:0});
    await page.locator('[data-ox-tab="ship"]').click();await page.waitForURL(`${base}/orders?status=ship`);
    assert.equal(await page.locator('tbody tr').count(),1);
    assert.match(await page.locator('tbody').innerText(),/Ready to ship.*Unpaid/s);

    // 3. Search sits inside the list (no separate button) and finds order numbers and customers.
    assert.equal(await page.locator('[data-ox-search] button').count(),0);
    await page.goto(`${base}/orders`);
    const listSearch=page.getByRole('searchbox',{name:'Search orders'});
    await listSearch.fill('SO-00003');await listSearch.press('Enter');await page.waitForURL(/q=SO-00003/);
    assert.equal(await page.locator('tbody tr').count(),1);
    await page.goto(`${base}/orders?q=Sarah`);assert.equal(await page.locator('tbody tr').count(),3);

    // 4. Row click opens the order; the row action goes to that step.
    await page.goto(`${base}/orders`);
    await Promise.all([page.waitForURL(new RegExp(`/orders/${ready.salesOrderId}$`)),
      page.locator(`tr[data-href="/orders/${ready.salesOrderId}"] td`).nth(2).click()]);
    await page.goto(`${base}/orders`);
    await Promise.all([page.waitForURL(new RegExp(`/orders/${draft.salesOrderId}#approve-order$`)),
      page.getByRole('link',{name:'Confirm SO-00003'}).click()]);
    assert.equal(await page.locator('.page-head [data-ox-order-actions]').count(),1,'Actions sit on the order header row');

    // 5. New order: ?customer= preselects; one customer search, one product search, live server totals.
    await page.goto(`${base}/orders/new?customer=${sarah.id}`);
    assert.equal(await page.locator('[data-ox-chip-name]').textContent(),'Sarah Klein');
    assert.match(await page.locator('[name=customerShippingAddress]').inputValue(),/120 Lee Ave/);
    assert.deepEqual(await page.locator('#sales-entry select[name="customerId"], #sales-entry select[name="skuId"]').evaluateAll((selects)=>
      selects.map((select)=>Math.round(select.getBoundingClientRect().width))),[1,1],'Native fields stay as 1px backing fields');
    assert.equal(await page.locator('[data-product-search]').count(),1);
    assert.equal(await page.locator('details.ox-more').evaluate((details)=>details.open),false);
    assert.equal(await page.locator('#sales-entry fieldset').count(),0);
    const formText=await page.locator('main').innerText();
    for(const removed of ['units requested','Product weight is missing','editable selling price','Choose products to see available stock'])
      assert.doesNotMatch(formText,new RegExp(removed));
    assert.equal(await page.locator('main a',{hasText:/^\s*←/}).count(),1);
    assert.deepEqual(await page.locator('select[name="fulfillmentLocationId"] option').allTextContents(),['Best location (auto)','Brooklyn Store'],
      'Sweep test locations are hidden from the demo picker');
    assert.equal(await page.locator('#order-customer option',{hasText:'Sweep'}).count(),0);
    const productSearch=page.getByRole('combobox',{name:'Search products'});
    await productSearch.fill('air max');
    await page.waitForFunction(()=>/18 in stock/.test(document.querySelector('#ox-product-list').textContent));
    assert.match(await page.locator('#ox-product-list').innerText(),/\$130\.00.*18 in stock/s);
    await productSearch.press('Enter');
    await productSearch.fill('AM90-BLACK-9');await productSearch.press('Enter');
    assert.equal(await page.locator('[data-order-line] [name=quantity]').first().inputValue(),'2','Picking the same product again adds one');
    await productSearch.fill('samba');await productSearch.press('ArrowDown');await productSearch.press('Escape');
    assert.equal(await page.locator('#ox-product-list').isHidden(),true);
    await productSearch.press('Enter');await productSearch.press('Enter');
    await page.getByRole('button',{name:'One more Samba OG / White 9'}).click();
    await page.getByRole('button',{name:'One more Samba OG / White 9'}).click();
    await page.waitForFunction(()=>document.querySelector('[data-total=totalMinor]').textContent.includes('560.00'));
    assert.match(await page.locator('#order-stock-check').innerText(),/1 of 2 items short/);
    await page.getByRole('button',{name:'Remove Samba OG / White 9'}).click();
    await page.waitForFunction(()=>document.querySelector('[data-total=totalMinor]').textContent.includes('260.00'));
    assert.match(await page.locator('#order-stock-check').innerText(),/All in stock\. Ready to create\./);
    assert.equal(await page.locator('.ox-side').evaluate((side)=>getComputedStyle(side).position),'sticky');
    // No processor is connected here: the link option says so and offers the connection.
    assert.equal(await page.locator('input[name=oxPayment][value=link]').isDisabled(),true);
    assert.equal(await page.locator('.ox-paychoice').getByRole('link',{name:'Connect payments'}).getAttribute('href'),'/settings/connections#payments');
    await page.locator('input[name=oxPayment][value=collect]').check();
    await Promise.all([page.waitForURL(/\/orders\/so_/),page.getByRole('button',{name:'Create order and reserve stock',exact:true}).click()]);
    const createdId=page.url().split('/').pop();
    const created=(await database.query(`SELECT so.status,so.ship_to_address,l.quantity_ordered FROM sales_orders so
      JOIN sales_order_lines l ON l.sales_order_id=so.id WHERE so.id=$1`,[createdId])).rows;
    assert.deepEqual(created.map((row)=>[row.status,Number(row.quantity_ordered)]),[['CONFIRMED',2]]);
    assert.match(created[0].ship_to_address,/120 Lee Ave/);
    assert.equal(await page.locator('.ox-toast').getAttribute('data-ox-title'),'Order created. 2 items held.');
    assert.match(await page.locator('.ox-toast').innerText(),/stock reserved/,'The server\'s own message stays on the page');

    // 5b. Creating and paying are separate: the order is unpaid, and "Collect payment now" opened the panel.
    const strip=page.locator('[data-ox-order-money]');
    assert.match(await strip.innerText(),/Order total\s+\$260\.00\s+Paid\s+\$0\.00\s+Balance due\s+\$260\.00\s+Payment\s+Unpaid/);
    assert.equal(await page.locator('#ox-collect').evaluate((details)=>details.open),true);
    assert.equal(await page.locator('#ox-collect').getByRole('link',{name:'Connect payments'}).getAttribute('href'),'/settings/connections#payments');
    await page.locator('[data-ox-collect-amount]').fill('100.00');
    await page.locator('#ox-collect select[name=method]').selectOption('cash');
    await Promise.all([page.waitForURL(new RegExp(`/orders/${createdId}`)),page.getByRole('button',{name:'Record payment',exact:true}).click()]);
    assert.match(await page.locator('[data-ox-order-money]').innerText(),/Paid\s+\$100\.00\s+Balance due\s+\$160\.00\s+Payment\s+Partly paid/);
    const deposit=(await database.query(`SELECT amount_minor,sales_order_id FROM accounting_payments WHERE sales_order_id=$1`,[createdId])).rows;
    assert.deepEqual(deposit.map((row)=>Number(row.amount_minor)),[10000]);
    assert.equal(Number((await database.query(`SELECT COUNT(*) AS n FROM sales_order_allocations a JOIN sales_order_lines l ON l.id=a.sales_order_line_id
      WHERE l.sales_order_id=$1`,[createdId])).rows[0].n)>0,true,'Paying moved no stock and the reservation stands');
    await page.locator('[data-ox-collect-amount]').evaluate((input)=>{input.max='';});
    await page.getByRole('link',{name:'Collect payment'}).click();
    await page.locator('[data-ox-collect-amount]').fill('500.00');
    await page.getByRole('button',{name:'Record payment',exact:true}).click();
    assert.match(await page.locator('main').innerText(),/more than this order still owes/);
    await page.goto(`${base}/orders?q=SO-00004`);
    assert.match(await page.locator('tbody').innerText(),/Partly paid/);

    // 6. Save draft creates a draft.
    await page.goto(`${base}/orders/new?customer=${sarah.id}`);
    await productSearch.fill('air max');await productSearch.press('Enter');
    await Promise.all([page.waitForURL(/\/orders\/so_/),page.getByRole('button',{name:'Save draft',exact:true}).click()]);
    assert.equal((await database.query('SELECT status FROM sales_orders WHERE id=$1',[page.url().split('/').pop()])).rows[0].status,'DRAFT');
    assert.match(await page.locator('.ox-toast').innerText(),/draft/i);

    // 7. New customer from the search list is created and selected; pickup hides Ship to and completes.
    await page.goto(`${base}/orders/new`);
    const customerSearch=page.getByRole('combobox',{name:'Search customers'});
    await customerSearch.fill('Maya');await page.getByRole('option',{name:/Add new customer/}).click();
    const dialog=page.locator('#new-order-customer');
    assert.equal(await dialog.locator('[name=name]').inputValue(),'Maya');
    await dialog.locator('[name=email]').fill('maya@example.test');await dialog.getByRole('button',{name:'Save customer'}).click();
    await dialog.waitFor({state:'hidden'});
    assert.equal(await page.locator('[data-ox-chip-name]').textContent(),'Maya');
    await productSearch.fill('air max');await productSearch.press('Enter');
    await page.getByText('Customer pickup',{exact:true}).click();
    assert.equal(await page.locator('#order-destination').isVisible(),false);
    assert.equal(await page.locator('[data-ox-from-label]').textContent(),'Pick up at');
    await Promise.all([page.waitForURL(/\/orders\/so_/),page.locator('#order-complete-button').click()]);
    assert.equal((await database.query('SELECT status FROM sales_orders WHERE id=$1',[page.url().split('/').pop()])).rows[0].status,'FULFILLED');

    // 8. Phone: sticky bottom bar, no sideways scroll, 16px inputs.
    await page.setViewportSize({width:390,height:844});
    await page.goto(`${base}/orders/new?customer=${sarah.id}`);
    await productSearch.fill('air max');await productSearch.press('Enter');
    const bar=await page.locator('.ox-mbar').boundingBox();
    assert.ok(bar&&bar.y+bar.height<=844&&bar.y>700,'The total bar sits at the bottom of the phone screen');
    await page.waitForFunction(()=>document.querySelector('[data-ox-mbar-total]').textContent.includes('130.00'));
    assert.equal(await page.locator('.ox-head--form .ox-head__actions').isHidden(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);
    assert.equal(await productSearch.evaluate((input)=>getComputedStyle(input).fontSize),'16px');
    await page.goto(`${base}/orders`);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);
    assert.deepEqual(errors,[]);
  });
