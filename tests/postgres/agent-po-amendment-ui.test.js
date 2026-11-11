'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');

test('a phone supplier submits revised PO terms and the owner reviews and applies the exact current changes',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-po-date-fixture').fixture(t),{db,ctx,po}=f;
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  const browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const origin='http://127.0.0.1:'+server.address().port,portal=origin+'/supplier/order/'+f.token;
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  for(const plan of ['starter','growth']){
    await f.subscribe(plan);
    await page.goto(portal);
    assert.equal(await page.getByRole('link',{name:'Propose a quantity or price change'}).count(),0);
  }
  await f.subscribe('pro');
  await page.goto(portal);
  await page.getByRole('link',{name:'Propose a quantity or price change'}).click();
  await page.locator('[name="terms[0][quantity]"]').fill('14');
  await page.locator('[name="terms[0][price]"]').fill('1.10');
  await page.getByLabel('I confirm the revised terms entered above.').check();
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Send exact changes'}).click()]);
  assert.match(page.url(),/saved=1/);
  await page.goto(origin+'/login');
  await page.getByLabel('Work email').fill(f.email);
  await page.locator('[name=password]').fill(f.password);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(origin+'/purchasing/orders/'+po.purchaseOrderId);
  await page.getByRole('link',{name:'Review supplier purchase changes',exact:true}).click();
  const text=await page.locator('main').innerText();
  assert.match(text,/Revised remaining 14/);
  assert.match(text,/\$1\.10/);
  for(const name of ['maximumQuantityPercent','maximumPricePercent','maximumOrderIncrease'])
    assert.equal(await page.locator('form[action$="/settings"] [name="'+name+'"]').inputValue(),'');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.getByLabel('I approve these exact supplier terms for the current purchase order.').check();
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Apply reviewed changes',exact:true}).click()]);
  assert.match(await page.locator('main').innerText(),/Purchase order updated/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  const line=(await db.query('SELECT quantity_units,unit_cost FROM purchase_order_lines WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,po.lineIds[0]])).rows[0];
  assert.deepEqual([Number(line.quantity_units),Number(line.unit_cost)],[14,1.10]);
  assert.deepEqual(errors,[]);
});
