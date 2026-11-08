'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{chromium}=require('playwright');
// A stock count gain is profit but not a sale: every profit figure lists it as its
// own part so the parts add up, and margins are worked out on sales alone. Lists
// page by 25, 50, 75 or 100 and can jump to a page. Every menu name is an address,
// and a page has one way back, none at all when it is a menu page.
test('profit parts add up, margins leave count gains out, lists jump pages, one way back',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:20}),{db,ctx}=f,workflows=f.workflows;
 const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
 const order=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:'margin-sale',lines:[{skuId:f.item.skuIds[0],quantity:2,unitPriceMinor:5000}]});
 await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'margin-confirm'});
 await workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'margin-fulfill',lines:[{lineId:order.lineIds[0],quantity:2,locationId:f.location.id}]});
 await require('../../src/accounting/postgres-ledger').post(db,ctx,{postingDate:today,sourceKey:'margin-count-gain',sourceType:'physical_count',description:'Count gain',currency:'USD',
  lines:[{accountKey:'INVENTORY_ASSET',debitMinor:20000},{accountKey:'INVENTORY_ADJUSTMENTS',creditMinor:20000}]});
 const pnl=await require('../../src/accounting/postgres-reports').profitAndLoss(db,ctx.workspaceId,{from:today,to:today});
 assert.equal(pnl.stockCountMinor,20000);
 // 130 more products so the product list has pages.
 const catalog=require('../../src/domain/postgres-catalog-service');
 for(let i=0;i<130;i++)await catalog.createItem(db,ctx,{name:'Pager product '+String(i).padStart(3,'0'),baseCode:'PG-'+String(i).padStart(3,'0'),trackingMode:'quantity'}).catch(error=>{throw new Error('createItem: '+error.message);});
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await chromium.launch(),base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const money=n=>'$'+(n/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 const trading=pnl.netIncomeMinor-pnl.stockCountMinor,margin=(trading/pnl.revenueMinor*100).toFixed(1)+'%',shownNet=(pnl.netIncomeMinor/pnl.revenueMinor*100).toFixed(1)+'%';
 const visibleBack=page=>page.locator('main').locator('.page-back:visible,.back-link:visible,.rm-head__back:visible,.ox-back:visible,.rm-back:visible');
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
  await Promise.all([page.waitForURL(base+'/'),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  // Money: the card's line adds up to its number, and the margin is on sales alone.
  await page.goto(base+'/money');const overview=(await page.locator('main').innerText()).replace(/\s+/g,' ');
  assert.match(overview,new RegExp('Profit this period '+money(pnl.netIncomeMinor).replace(/[$.]/g,'\\$&')+' Sales '+money(pnl.revenueMinor).replace(/[$.]/g,'\\$&')+' − costs '+money(pnl.cogsMinor+pnl.operatingExpenseMinor).replace(/[$.]/g,'\\$&')+' \\+ stock count \\$200\\.00'),overview);
  {const short=n=>String(Math.round(n/pnl.revenueMinor*1000)/10)+'%';assert(overview.includes('Net margin '+short(trading)),overview);assert(!overview.includes('Net margin '+short(pnl.netIncomeMinor)));}
  await page.goto(base+'/money/profit');const profit=(await page.locator('main').innerText()).replace(/\s+/g,' ');
  assert.match(profit,new RegExp('Net margin '+margin.replace('.','\\.')+' \\(stock count gains / losses left out\\)'),profit);
  assert.match(profit,/This month \$[\d,.]+ Gross \$[\d,.]+ · stock count \+\$200\.00 · expenses \$[\d,.]+/,profit);
  assert.match(profit,/Year to date \$[\d,.]+ Gross \$[\d,.]+ · stock count \+\$200\.00 · expenses/,profit);
  if(process.env.SHOT_DIR)await page.screenshot({path:require('node:path').join(process.env.SHOT_DIR,'money-profit-'+width+'.png'),fullPage:true});
  // Rows per page offers 100 and a page number can be typed.
  await page.goto(base+'/inventory');
  assert.deepEqual(await page.locator('[data-pager] select[name=rows] option').allInnerTexts(),['25','50','75','100']);
  await page.locator('.pager-bar__jump input[name=page]').fill('3');
  await Promise.all([page.waitForURL(/page=3/),page.locator('.pager-bar__jump').getByRole('button',{name:'Go'}).click()]);
  assert.equal(await page.locator('.pager-bar__jump input[name=page]').inputValue(),'3');
  assert.match((await page.locator('[data-pager]').innerText()).replace(/\s+/g,' '),/51–75 of \d+/);
  await page.locator('[data-pager] select[name=rows]').selectOption('100');await page.waitForURL(/rows=100/);
  assert.match((await page.locator('[data-pager]').innerText()).replace(/\s+/g,' '),/1–100 of \d+/);
  if(process.env.SHOT_DIR)await page.locator('[data-pager]').screenshot({path:require('node:path').join(process.env.SHOT_DIR,'inventory-pager-'+width+'.png')});
  // Menu pages have no "Back to"; a product page has exactly one way back, even from a filtered list.
  for(const menu of ['/reports','/inventory','/money','/orders'])
  {await page.goto(base+'/');await page.goto(base+menu);assert.equal(await page.locator('main a.page-back').count(),0,menu);}
  await page.goto(base+'/inventory?rows=50&sort=name');
  await Promise.all([page.waitForURL(/\/inventory\/item_/),page.locator('main a[href^="/inventory/item_"]').first().click()]);
  assert.equal(await visibleBack(page).count(),1,'one way back on a product page');
  await page.goto(base+"/reports");await page.goto(base+"/inventory/"+(f.item.itemId||f.item.id));{const all=await page.locator(".page-back,.back-link,.rm-head__back,.ox-back,.rm-back").evaluateAll(n=>n.map(a=>[a.className,a.textContent.trim(),a.getAttribute("href"),getComputedStyle(a).display,a.hidden]));assert.equal(await visibleBack(page).count(),1,JSON.stringify(all)+" "+page.url());}
  // Every menu name is also an address.
  for(const [typed,lands] of [['/buy','/purchasing/orders'],['/stock','/inventory'],['/home','/']]){const response=await page.goto(base+typed);assert.equal(response.status(),200,typed);assert.equal(new URL(page.url()).pathname,lands);}
  assert.deepEqual(errors,[]);await page.close();
 }
});
