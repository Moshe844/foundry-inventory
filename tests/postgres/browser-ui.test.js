'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { chromium }=require('playwright');
const { startCluster }=require('../helpers/postgres-cluster');
const { openPostgres }=require('../../src/db/postgres');
const { migratePostgres }=require('../../src/db/migrate-postgres');
const { createPostgresApp }=require('../../src/postgres-app');

const provider={name:'browser-fixture',model:'browser-fixture',async complete(){return {data:{intent:'lookup',view:'inventory',
  action:null,search:'Browser Widget',sku:null,location:null,fromLocation:null,toLocation:null,quantity:null,
  countedQuantity:null,reason:null,reference:null},usage:{}};}};

test('Chromium operates PostgreSQL onboarding, catalog, inventory movement and Ask pages',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-browser-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-browser-secret',aiProvider:provider});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{
      await browser.close();
      await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();
      await database.close();
      cluster.stop();
    });
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));
    page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Browser Business');
    await page.getByLabel('Your name').fill('Browser Owner');
    await page.getByLabel('Work email').fill('browser-pg@example.test');
    await page.getByLabel('Password').fill('browser-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    assert.equal(await page.locator('.rm-source-grid > *').count(),3);
    await Promise.all([page.waitForURL(`${base}/inventory/new`),page.getByRole('button',{name:/Enter it manually/}).click()]);
    await page.goto(`${base}/locations`);
    await page.getByRole('button',{name:'Add your first location'}).click();
    await page.getByLabel('Name').fill('Browser Warehouse');
    await Promise.all([page.waitForURL(`${base}/locations`),page.locator('#modal-location').getByRole('button',{name:'Add location',exact:true}).click()]);
    assert.match(await page.locator('main').innerText(),/Browser Warehouse/);
    await page.goto(`${base}/inventory/new`);
    await page.getByLabel('Name',{exact:true}).fill('Browser Widget');
    await page.getByLabel('Item code').fill('BROWSER-1');
    await Promise.all([page.waitForURL(/\/inventory\/item_/),page.getByRole('button',{name:'Create item'}).click()]);
    await page.getByRole('button',{name:'Some came in'}).click();
    await page.getByRole('dialog').getByLabel('Quantity').fill('14');
    await page.getByRole('dialog').getByLabel('Reference').fill('BROWSER-OPENING');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Record receipt'}).click()]);
    assert.match(await page.locator('main').innerText(),/14\s+units on hand/);
    await page.goto(`${base}/ask`);
    await page.getByLabel('Ask StockChief').fill('How many Browser Widget do we have?');
    await Promise.all([page.waitForURL(`${base}/ask#latest`),page.getByRole('button',{name:'Continue'}).click()]);
    assert.match(await page.locator('main').innerText(),/1 SKU matched with 14 units on hand/);
    await page.getByText('Records behind this').click();
    assert.match(await page.locator('main').innerText(),/BROWSER-1/);
    assert.deepEqual(errors,[]);
  });
