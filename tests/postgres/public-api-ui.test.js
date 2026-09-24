'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');

test('real Chromium creates, exercises and revokes a scoped PostgreSQL inventory API client',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-public-api-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-public-api-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();const browserContext=await browser.newContext();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browserContext.newPage();page.setDefaultTimeout(30000);
    const errors=[];page.on('pageerror',(error)=>errors.push(error.message));
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('API Business');
    await page.getByLabel('Your name').fill('API Owner');
    await page.getByLabel('Work email').fill('api-owner@example.test');
    await page.getByLabel('Password').fill('api-owner-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    await page.goto(`${base}/locations`);await page.getByRole('button',{name:'Add your first location'}).click();
    await page.getByLabel('Name').fill('API Warehouse');
    await Promise.all([page.waitForURL(`${base}/locations`),page.locator('#modal-location').getByRole('button',{name:'Add location',exact:true}).click()]);
    await page.goto(`${base}/inventory/new`);await page.getByLabel('Name',{exact:true}).fill('API Widget');
    await page.getByLabel('Item code').fill('API-1');
    await Promise.all([page.waitForURL(/\/inventory\/item_/),page.getByRole('button',{name:'Create item'}).click()]);
    await page.goto(`${base}/settings/connections`);
    await page.getByLabel('Client name').fill('Warehouse client');
    await page.getByLabel('Read inventory').check();
    await page.getByLabel(/Receive or correct inventory/).check();
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Create scoped token'}).click()]);
    const token=await page.getByLabel('New API token').inputValue();
    assert.match(token,/^fnd_api_/);
    const headers={Authorization:`Bearer ${token}`};
    const initial=await page.request.get(`${base}/api/v1/public/inventory?limit=1`,{headers});
    assert.equal(initial.status(),200);const inventoryPage=await initial.json();
    assert.equal(inventoryPage.sourceOfTruth,'StockChief canonical PostgreSQL inventory engine');
    assert.equal(inventoryPage.data.length,1);assert.equal(inventoryPage.data[0].code,'API-1');
    assert.equal(inventoryPage.data[0].onHand,0);
    const command={skuId:inventoryPage.data[0].skuId,locationId:inventoryPage.data[0].locationId,
      quantity:7,reference:'API-RECEIPT-1'};
    const commandHeaders={...headers,'Idempotency-Key':'receipt-1'};
    const first=await page.request.post(`${base}/api/v1/public/commands/inventory/receive`,
      {headers:commandHeaders,data:command});
    assert.equal(first.status(),201);assert.equal((await first.json()).result.verifiedOnHand,7);
    const replay=await page.request.post(`${base}/api/v1/public/commands/inventory/receive`,
      {headers:commandHeaders,data:command});
    assert.equal(replay.status(),200);const replayed=await replay.json();
    assert.equal(replayed.replayed,true);assert.equal(replayed.result.verifiedOnHand,7);
    const conflict=await page.request.post(`${base}/api/v1/public/commands/inventory/receive`,
      {headers:commandHeaders,data:{...command,quantity:8}});
    assert.equal(conflict.status(),409);assert.match((await conflict.json()).error.message,/different command/);
    const movements=await database.query(`SELECT COUNT(*) AS count FROM movements WHERE reference='API-RECEIPT-1'`);
    assert.equal(movements.rows[0].count,'1');
    await page.getByRole('button',{name:'Revoke',exact:true}).click();
    await page.locator('dialog[open]').getByRole('button',{name:'Revoke',exact:true}).click();
    await page.getByText('Revoked',{exact:true}).waitFor();
    const refused=await page.request.get(`${base}/api/v1/public/inventory`,{headers});
    assert.equal(refused.status(),401);
    assert.match(await page.locator('main').innerText(),/Warehouse client[\s\S]*Revoked/);
    assert.deepEqual(errors,[]);
  });
