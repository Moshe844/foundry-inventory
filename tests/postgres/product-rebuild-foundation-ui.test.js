'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{chromium}=require('playwright');
test('shared presentation preserves business values while supplier creation, dates and order detail work',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:8}),{db,ctx}=f;
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'presentation-only-fixture'}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await chromium.launch(),context=await browser.newContext({timezoneId:'America/New_York'}),page=await context.newPage(),origin='http://127.0.0.1:'+server.address().port,errors=[];
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);
 await db.query("UPDATE workspaces SET time_zone='America/New_York' WHERE id=$1",[ctx.workspaceId]);
 await page.goto(origin+'/login');await page.locator('[name=email]').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 const before=(await db.query('SELECT (SELECT COUNT(*) FROM accounting_journal_entries WHERE workspace_id=$1)::int journals,(SELECT SUM(on_hand) FROM balances WHERE workspace_id=$1)::text units',[ctx.workspaceId])).rows[0];
 await t.test('supplier-create URL is a working form and retains a rejected input',async()=>{
  assert.equal((await page.goto(origin+'/suppliers/new')).status(),200);assert.equal(await page.locator('h1').innerText(),'Add supplier');
  await page.getByLabel('Name',{exact:true}).fill('Unfamiliar supplier name');await page.getByLabel('Email',{exact:true}).fill('supplier@example.test');await page.getByLabel('Usual lead time (days)').fill('-1');
  await page.locator('[name=defaultLeadTimeDays]').evaluate(e=>e.removeAttribute('min'));await page.getByRole('button',{name:'Save supplier',exact:true}).click();
  assert.equal(await page.getByLabel('Name',{exact:true}).inputValue(),'Unfamiliar supplier name');assert.match(await page.locator('[role=alert]').innerText(),/lead time|days/i);
  await page.getByLabel('Usual lead time (days)').fill('4');await Promise.all([page.waitForURL(/\/suppliers\/sup_/),page.getByRole('button',{name:'Save supplier',exact:true}).click()]);
  const suppliers=(await db.query('SELECT name FROM suppliers WHERE workspace_id=$1 AND name=$2',[ctx.workspaceId,'Unfamiliar supplier name'])).rows;assert.equal(suppliers.length,1);
 });
 await t.test('item timestamp date and full timestamp agree at a New York day boundary',async()=>{
  await db.query('UPDATE items SET created_at=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,f.item.itemId,'2026-10-26T00:30:00.000Z']);await page.goto(origin+'/inventory/'+f.item.itemId);
  assert.match(await page.locator('main').innerText(),/Added\s+Oct 25, 2026/);
 });
 await t.test('safe page browsing never creates stock or accounting effects',async()=>{
  for(const route of ['/inventory','/orders','/purchasing','/money']){await page.goto(origin+route);assert.equal(await page.locator('main form[action="/ask"]').count(),0,route);}
  const after=(await db.query('SELECT (SELECT COUNT(*) FROM accounting_journal_entries WHERE workspace_id=$1)::int journals,(SELECT SUM(on_hand) FROM balances WHERE workspace_id=$1)::text units',[ctx.workspaceId])).rows[0];assert.deepEqual(after,before);
 });
 await t.test('order lines and payment values are visible without opening a disclosure',async()=>{
  const order=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:'presentation-sale',lines:[{skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:1257}]});await f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'presentation-reserve'});await f.workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'presentation-pickup',lines:[{lineId:order.lineIds[0],locationId:f.location.id,quantity:1}]});
  await page.goto(origin+'/orders/'+order.salesOrderId);const lines=page.locator('[data-order-lines]');assert(await lines.isVisible());assert.equal(await lines.evaluate(e=>e.tagName==='DETAILS'&&!e.open),false);
  const payment=page.getByRole('region',{name:'Payment summary',exact:true});assert(await payment.isVisible());assert.match(await payment.innerText(),/Invoiced\s+\$12\.57/);assert.match(await payment.innerText(),/Paid\s+\$0\.00/);assert.match(await payment.innerText(),/Refunded\s+\$0\.00/);assert.match(await payment.innerText(),/Balance\s+\$12\.57/);
  assert.doesNotMatch(await page.locator('main').innerText(),/1\s+Units ordered/);
 });
 assert.deepEqual(errors,[]);
});
