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
    const invalidRegistration=await page.locator('form[action="/register"]').evaluate(form=>[...form.elements].filter(field=>field.willValidate&&!field.checkValidity()).map(field=>({name:field.name,message:field.validationMessage})));
    assert.deepEqual(invalidRegistration,[],'Registration form must be valid before submitting');
    const [registration]=await Promise.all([page.waitForResponse(response=>response.request().method()==='POST'&&response.url()===`${base}/register`),page.getByRole('button',{name:'Create account'}).click()]);
    const registrationBody=registration.status()===302?'':await registration.text();
    const registrationAlerts=[...registrationBody.matchAll(/<div[^>]*class="auth-message[^"]*"[^>]*>([\s\S]*?)<\/div>/g)].map(match=>match[1].replace(/<[^>]*>/g,' ').trim());
    assert.equal(registration.status(),302,JSON.stringify({alerts:registrationAlerts,title:/<title>([^<]*)/.exec(registrationBody)?.[1],fromServiceWorker:registration.fromServiceWorker(),location:registration.headers().location}));
    await page.waitForURL(`${base}/onboarding`);
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
    assert.deepEqual(await page.locator('select[name="fulfillmentLocationId"] option').allTextContents(),['Best location (auto)','Brooklyn Store','SWEEP WH <i>Ä</i>'],
      'Every location of this business is listed, whatever the business is called, and a name is shown as plain text');
    assert.equal(await page.locator('#order-customer option',{hasText:'Sweep'}).count(),1);
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
    // No gateway is connected here: no link option, and the form does not send people away to connect.
    assert.equal(await page.locator('input[name=oxPayment][value=link]').count(),0);
    assert.equal(await page.locator('#sales-entry').getByRole('link',{name:/connect/i}).count(),0);
    await page.locator('input[name=oxPayment][value=collect]').check();
    await Promise.all([page.waitForURL(/\/orders\/so_/),page.getByRole('button',{name:'Create order and reserve stock',exact:true}).click()]);
    const createdId=page.url().split('/').pop();
    const created=(await database.query(`SELECT so.status,so.ship_to_address,l.quantity_ordered FROM sales_orders so
      JOIN sales_order_lines l ON l.sales_order_id=so.id WHERE so.id=$1`,[createdId])).rows;
    assert.deepEqual(created.map((row)=>[row.status,Number(row.quantity_ordered)]),[['CONFIRMED',2]]);
    assert.match(created[0].ship_to_address,/120 Lee Ave/);
    assert.equal(await page.locator('.ox-toast').getAttribute('data-ox-title'),'Order created. 2 items held.');
    assert.match(await page.locator('.ox-toast').innerText(),/stock reserved/,'The server\'s own message stays on the page');

    // 5b. Creating and paying are separate: "Collect payment now" opened the payment dialog on Cash.
    const pay=page.locator('#ox-pay');
    const collectPayment=async()=>{
      // Saving cash redirects to the same URL: waitForURL alone can resolve
      // before the replacement document has attached its payment handlers.
      await page.waitForFunction(()=>typeof document.querySelector('#ox-pay')?.oxShow==='function');
      await page.getByRole('button',{name:'Collect payment'}).click();
      assert.equal(await pay.evaluate(dialog=>dialog.open),true);
    };
    assert.equal(await pay.evaluate((dialog)=>dialog.open),true);
    assert.match(await page.locator('[data-ox-paycard]').innerText(),/Payment\s+Unpaid\s+Order total\s+\$260\.00\s+Paid\s+\$0\.00\s+Balance due\s+\$260\.00/);
    // Cash: what was handed over, the change worked out, only what is owed recorded.
    await pay.locator('[data-ox-cash-received]').fill('300');
    assert.match(await pay.locator('.ox-pay__calc').innerText(),/Goes to this order\s+\$260\.00\s+Change to give back\s+\$40\.00\s+Still owed after this\s+\$0\.00/);
    await pay.locator('[data-ox-cash-received]').fill('100');
    assert.match(await pay.locator('.ox-pay__calc').innerText(),/Change to give back\s+\$0\.00\s+Still owed after this\s+\$160\.00/);
    await Promise.all([page.waitForURL(new RegExp('/orders/'+createdId)),pay.getByRole('button',{name:'Record $100.00 cash'}).click()]);
    assert.match(await page.locator('[data-ox-paycard]').innerText(),/Partly paid[\s\S]*Paid\s+\$100\.00\s+Balance due\s+\$160\.00[\s\S]*\$100\.00\s+cash/);
    // Card without a gateway: one way to connect, which opens just the payment gateways.
    await collectPayment();
    await pay.getByRole('tab',{name:'Card'}).click();
    const gateway=pay.getByRole('link',{name:'Connect Sola or Stripe'});
    assert.equal(await gateway.getAttribute('href'),'/settings/connections?only=payments&return=/orders/'+createdId);
    assert.equal(await pay.locator('[data-ox-pay-panel=card] button[type=submit]').count(),0,'No charge button without a gateway');
    await Promise.all([page.waitForURL(/only=payments/),gateway.click()]);
    assert.equal(await page.locator('main h1').innerText(),'Payment gateways');
    assert.ok((await page.locator('[data-integration-card]').evaluateAll((cards)=>cards.map((card)=>card.dataset.integrationCard)))
      .every((type)=>['stripe','cardknox'].includes(type)),'Only payment gateways are shown');
    assert.equal(await page.locator('#shipping, .sc-connected-section').count(),0);
    await Promise.all([page.waitForURL(new RegExp('/orders/'+createdId+'$')),page.getByRole('link',{name:'Back to the order'}).click()]);
    // Bank transfer: add the business's bank details once, give them to the customer, mark it received.
    await collectPayment();
    await pay.getByRole('tab',{name:'Bank transfer'}).click();
    const bankForm=pay.locator('.ox-bank-form');
    await bankForm.getByLabel('Account name').fill('Hendels Shoes LLC');await bankForm.getByLabel('Bank',{exact:true}).fill('Chase');
    await bankForm.getByLabel('Routing number').fill('021000021');await bankForm.getByLabel('Account number').fill('123456789');
    await Promise.all([page.waitForURL(/pay=transfer/),bankForm.getByRole('button',{name:'Save bank details'}).click()]);
    assert.equal(await pay.evaluate((dialog)=>dialog.open),true,'Back on the transfer step after saving');
    assert.match(await pay.locator('.ox-bank').innerText(),/Chase[\s\S]*Hendels Shoes LLC[\s\S]*021000021[\s\S]*123456789[\s\S]*SO-00004/);
    await pay.getByLabel('Amount received').fill('60.00');
    await Promise.all([page.waitForURL(new RegExp('/orders/'+createdId)),pay.getByRole('button',{name:'Mark transfer received'}).click()]);
    const paid=(await database.query('SELECT amount_minor,method FROM accounting_payments WHERE sales_order_id=$1 ORDER BY created_at',[createdId])).rows;
    assert.deepEqual(paid.map((row)=>[Number(row.amount_minor),row.method]),[[10000,'cash'],[6000,'bank transfer']]);
    assert.match(await page.locator('[data-ox-paycard]').innerText(),/Balance due\s+\$100\.00/);
    assert.equal((await page.goto(base+await page.locator('.ox-receipts a').first().getAttribute('href'))).status(),200);
    await page.goto(base+'/orders/'+createdId);
    assert.equal(Number((await database.query('SELECT COUNT(*) AS n FROM sales_order_allocations a JOIN sales_order_lines l ON l.id=a.sales_order_line_id WHERE l.sales_order_id=$1',[createdId])).rows[0].n)>0,true,'Paying moved no stock');
    // A carrier order: the next step is picking, offered once, in the Fulfilment card; no pickup step.
    const actions=page.locator('[data-ox-order-actions]');
    assert.equal(await actions.locator('.ox-btn--primary').count(),0,'The header repeats no step');
    assert.equal(await page.getByRole('button',{name:/Start picking/}).count(),1);
    assert.equal(await page.locator('#fulfilment').getByRole('button',{name:/Start picking/}).count(),1);
    assert.equal(await page.getByRole('button',{name:'Mark picked up'}).count(),0);
    // Edit a confirmed, part-paid order: the held stock follows the new quantity.
    await Promise.all([page.waitForURL(/\/edit$/),actions.getByRole('link',{name:'Edit'}).click()]);
    assert.equal(await page.locator('main h1').innerText(),'Edit order SO-00004');
    await page.locator('[data-order-line] [name=quantity]').first().fill('3');
    await page.waitForFunction(()=>document.querySelector('[data-total=totalMinor]').textContent.includes('390.00'));
    await Promise.all([page.waitForURL(new RegExp('/orders/'+createdId+'$')),page.locator('.ox-sum__btns button[type=submit]').click()]);
    const edited=(await database.query('SELECT so.status,l.quantity_ordered,(SELECT SUM(a.quantity) FROM sales_order_allocations a WHERE a.sales_order_line_id=l.id) AS held FROM sales_orders so JOIN sales_order_lines l ON l.sales_order_id=so.id WHERE so.id=$1',[createdId])).rows;
    assert.deepEqual(edited.map((row)=>[row.status,Number(row.quantity_ordered),Number(row.held)]),[['CONFIRMED',3,3]]);
    assert.match(await page.locator('[data-ox-paycard]').innerText(),/Order total\s+\$390\.00\s+Paid\s+\$160\.00\s+Balance due\s+\$230\.00/);
    // Overpaying is refused.
    await collectPayment();
    await pay.getByRole('tab',{name:'Cheque'}).click();
    await pay.getByLabel('Cheque amount').evaluate((input)=>{input.max='';input.value='900.00';});
    await pay.getByRole('button',{name:'Record cheque'}).click();
    assert.match(await page.locator('main').innerText(),/more than this order still owes/);
    await page.goto(base+'/orders?q=SO-00004');
    assert.match(await page.locator('tbody').innerText(),/Partly paid/);

    // 6. Save draft creates a draft.
    await page.goto(`${base}/orders/new?customer=${sarah.id}`);
    await productSearch.fill('air max');await productSearch.press('Enter');
    await Promise.all([page.waitForURL(/\/orders\/so_/),page.getByRole('button',{name:'Save draft',exact:true}).click()]);
    assert.equal((await database.query('SELECT status FROM sales_orders WHERE id=$1',[page.url().split('/').pop()])).rows[0].status,'DRAFT');
    assert.match(await page.locator('.ox-toast').innerText(),/draft/i);
    // A draft can be edited from the header.
    await Promise.all([page.waitForURL(/\/edit$/),page.locator('[data-ox-order-actions]').getByRole('link',{name:'Edit draft order',exact:true}).click()]);
    assert.equal(await page.locator('main h1').innerText(),'Edit draft order');
    assert.equal(await page.locator('[data-order-line] [name=quantity]').first().inputValue(),'1');

    // 6b. A pickup order's next step is the hand-over, not shipping.
    await page.goto(`${base}/orders/new?customer=${sarah.id}`);
    await productSearch.fill('air max');await productSearch.press('Enter');
    await page.getByText('Customer pickup',{exact:true}).click();
    await Promise.all([page.waitForURL(/\/orders\/so_/),page.getByRole('button',{name:'Create order and reserve stock',exact:true}).click()]);
    const pickupActions=page.locator('[data-ox-order-actions]');
    const pickupCard=page.locator('#record-left');
    assert.equal(await pickupCard.locator('summary h2').first().innerText(),'Ready for pickup');
    assert.equal(await pickupCard.evaluate((details)=>details.open),true);
    assert.equal(await pickupCard.getByRole('button',{name:'Mark picked up'}).count(),1);
    assert.equal(await pickupCard.locator('[name=trackingNumber], [name=carrier]').count(),0,'No carrier questions for a counter pickup');
    assert.equal(await page.locator('#fulfilment').count(),0,'Nothing to pick or ship');
    // It is the first card on the page, above what was ordered.
    assert.ok((await pickupCard.boundingBox()).y<(await page.locator('[data-order-lines]').boundingBox()).y);
    // Cancel order: a confirmation, then the held stock is released.
    const cancelId=page.url().split('?')[0].split('#')[0].split('/').pop();
    await pickupActions.getByRole('button',{name:'Cancel order'}).click();
    const cancelDialog=page.locator('#ox-cancel');
    assert.match(await cancelDialog.innerText(),/stock held for this order goes back to available/);
    await cancelDialog.getByLabel(/Reason/).fill('Customer changed their mind');
    await Promise.all([page.waitForURL(new RegExp('/orders/'+cancelId)),cancelDialog.getByRole('button',{name:'Cancel order'}).click()]);
    const cancelled=(await database.query('SELECT status,cancel_reason FROM sales_orders WHERE id=$1',[cancelId])).rows[0];
    assert.deepEqual([cancelled.status,cancelled.cancel_reason],['CANCELLED','Customer changed their mind']);
    assert.equal(Number((await database.query('SELECT COUNT(*) AS n FROM sales_order_allocations a JOIN sales_order_lines l ON l.id=a.sales_order_line_id WHERE l.sales_order_id=$1',[cancelId])).rows[0].n),0);
    assert.equal(await page.locator('[data-ox-order-actions]').getByRole('button',{name:'Cancel order'}).count(),0);

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
