'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');

async function addLocation(page,base,name){
  await page.goto(`${base}/locations`);
  await page.getByRole('button',{name:/Add (your first )?location/}).first().click();
  const dialog=page.locator('#modal-location');
  await dialog.getByLabel('Name').fill(name);
  await Promise.all([page.waitForNavigation(),dialog.getByRole('button',{name:'Add location',exact:true}).click()]);
}

async function addItem(page,base,{name,code,tracking='quantity',variants=false}){
  await page.goto(`${base}/inventory/new`);
  await page.getByLabel('Name',{exact:true}).fill(name);
  await page.getByLabel('Item code').fill(code);
  if(tracking==='serial')await page.getByLabel('Individual units').check();
  if(tracking==='lot')await page.getByLabel('Lots / batches').check();
  if(variants){
    await page.getByLabel(/comes in options/).check();
    await page.getByLabel('First option name').fill('Colour');
    await page.getByLabel('First option choices').fill('Black, White');
    await page.getByLabel('Second option name').fill('Size');
    await page.getByLabel('Second option choices').fill('Small, Large');
  }
  await Promise.all([page.waitForURL(/\/inventory\/item_/),page.getByRole('button',{name:'Create item'}).click()]);
}

test('real Chromium certifies complete PostgreSQL onboarding and tracked-catalog pages',
  {timeout:240000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-full-catalog-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-full-catalog-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;

    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Catalog Certification');
    await page.getByLabel('Your name').fill('Catalog Owner');
    await page.getByLabel('Work email').fill('catalog-full-pg@example.test');
    await page.getByLabel('Password').fill('catalog-full-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    assert.equal(await page.locator('.rm-source-grid > *').count(),3);
    const onboardingText=await page.locator('main').innerText();
    assert.match(onboardingText,/Move from files[\s\S]*Connect another system[\s\S]*Enter it manually/);
    assert.doesNotMatch(onboardingText,/Use several sources|Use email attachments/);
    assert.equal(await page.getByLabel('Inventory name').inputValue(),'Catalog Certification');
    assert.equal(await page.getByLabel('Inventory spreadsheets').isVisible(),true);

    await Promise.all([page.waitForURL(`${base}/inventory`),page.getByRole('button',{name:'Load sample data to explore'}).click()]);
    assert.match(await page.locator('main').innerText(),/Sample inventory[\s\S]*Sample coffee beans/);
    assert.match(await page.locator('main').innerText(),/cannot be converted to real data/i);
    await Promise.all([page.waitForURL(`${base}/inventory`),page.getByRole('button',{name:'Clear sample data'}).click()]);
    assert.match(await page.locator('main').innerText(),/No products yet/);
    assert.doesNotMatch(await page.locator('main').innerText(),/Sample coffee beans/);

    await addLocation(page,base,'North Warehouse');
    await addLocation(page,base,'South Warehouse');
    await addItem(page,base,{name:'Variant Jacket',code:'JACKET',variants:true});
    assert.match(await page.locator('main').innerText(),/4 variants/);
    await page.getByRole('button',{name:'Edit details'}).click();
    const edit=page.locator('#modal-edit');await edit.getByLabel('Name').fill('Field Jacket');
    await Promise.all([page.waitForNavigation(),edit.getByRole('button',{name:'Save details'}).click()]);
    assert.match(await page.locator('h1').innerText(),/Field Jacket/);
    await page.getByRole('button',{name:'Add variant'}).click();
    const variant=page.locator('#modal-variant');
    await variant.getByLabel('Colour').fill('Blue');await variant.getByLabel('Size').fill('Large');
    await Promise.all([page.waitForNavigation(),variant.getByRole('button',{name:'Add variant'}).click()]);
    assert.match(await page.locator('main').innerText(),/5 variants/);
    assert.match(await page.locator('main').innerText(),/Blue \/ Large/);

    await addItem(page,base,{name:'Serialized Scanner',code:'SCAN',tracking:'serial'});
    const scannerUrl=page.url();
    await page.getByRole('button',{name:'Some came in'}).click();
    let dialog=page.locator('#modal-receive');
    await dialog.getByLabel('Location').selectOption({label:'North Warehouse'});
    await dialog.getByLabel(/Serial numbers/).fill('SCN-001\nSCN-002');
    await Promise.all([page.waitForNavigation(),dialog.getByRole('button',{name:'Record receipt'}).click()]);
    assert.match(await page.locator('main').innerText(),/2\s+units on hand/);
    await page.getByRole('button',{name:'Sold or used'}).click();dialog=page.locator('#modal-issue');
    await dialog.getByLabel('Exact serial units').selectOption({index:0});
    await dialog.getByLabel('Reason').selectOption({index:1});
    await Promise.all([page.waitForNavigation(),dialog.getByRole('button',{name:'Record issue'}).click()]);
    assert.match(await page.locator('main').innerText(),/1\s+unit on hand/);
    await page.getByRole('button',{name:'Request a move'}).click();dialog=page.locator('#modal-transfer');
    await dialog.getByLabel('Exact serial units').selectOption({index:0});
    await dialog.locator('select[name="toLocationId"]').selectOption({label:'South Warehouse'});
    await Promise.all([page.waitForURL(/\/transfers\/tr_/),dialog.getByRole('button',{name:'Create transfer request'}).click()]);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve this move'}).click()]);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:/Confirm 1 unit left/}).click()]);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Record serial outcomes'}).click()]);
    await page.goto(scannerUrl);
    assert.match(await page.locator('main').innerText(),/South Warehouse\s+1/);

    await addItem(page,base,{name:'Lot Coffee',code:'LOT-COFFEE',tracking:'lot'});
    const lotUrl=page.url();
    await page.getByRole('button',{name:'Some came in'}).click();dialog=page.locator('#modal-receive');
    await dialog.getByLabel('Location').selectOption({label:'North Warehouse'});
    await dialog.getByLabel('Quantity').fill('10');await dialog.getByLabel('Lot or batch number').fill('ROAST-100');
    await Promise.all([page.waitForNavigation(),dialog.getByRole('button',{name:'Record receipt'}).click()]);
    await page.getByRole('button',{name:'Sold or used'}).click();dialog=page.locator('#modal-issue');
    await dialog.getByLabel('From').selectOption({label:'North Warehouse'});
    await dialog.getByLabel('Exact lot').selectOption({index:0});await dialog.getByLabel('Quantity').fill('3');
    await dialog.getByLabel('Reason').selectOption({index:1});
    await Promise.all([page.waitForNavigation(),dialog.getByRole('button',{name:'Record issue'}).click()]);
    assert.match(await page.locator('main').innerText(),/7\s+units on hand/);
    await page.getByRole('button',{name:'Request a move'}).click();dialog=page.locator('#modal-transfer');
    await dialog.locator('select[name="fromLocationId"]').selectOption({label:'North Warehouse'});
    await dialog.getByLabel('Exact lot').selectOption({index:0});await dialog.getByLabel('Quantity').fill('2');
    await dialog.locator('select[name="toLocationId"]').selectOption({label:'South Warehouse'});
    await Promise.all([page.waitForURL(/\/transfers\/tr_/),dialog.getByRole('button',{name:'Create transfer request'}).click()]);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve this move'}).click()]);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:/Confirm 2 units left/}).click()]);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Confirm all 2 arrived'}).click()]);
    await page.goto(lotUrl);
    assert.match(await page.locator('main').innerText(),/South Warehouse\s+2/);
    assert.deepEqual(errors,[]);
  });
