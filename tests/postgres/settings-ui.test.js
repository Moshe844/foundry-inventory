'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { chromium }=require('playwright');
const { startCluster }=require('../helpers/postgres-cluster');
const { openPostgres }=require('../../src/db/postgres');
const { migratePostgres }=require('../../src/db/migrate-postgres');
const { createPostgresApp }=require('../../src/postgres-app');

test('PostgreSQL account menu pages render truthful native settings and rename the active inventory in Chromium',
  {timeout:180000},async(context)=>{const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-settings-ui'});await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'settings-ui-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Settings Operation');
    await page.getByLabel('Your name').fill('Settings Owner');await page.getByLabel('Work email').fill('settings@example.test');
    await page.getByLabel('Password').fill('settings-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    await page.goto(`${base}/what-you-told-me`);assert.match(await page.locator('main').innerText(),/haven't told me any standing rules yet/i);
    await page.goto(`${base}/everything`);const directory=await page.locator('main').innerText();
    assert.match(directory,/Inventory catalogue/);assert.match(directory,/Business connections/);
    await page.goto(`${base}/settings`);assert.match(await page.locator('main').innerText(),/shared PostgreSQL storage/i);
    await page.getByLabel('Inventory name').fill('Renamed Operation');
    await Promise.all([page.waitForURL(`${base}/settings`),page.getByRole('button',{name:'Save name'}).click()]);
    assert.match(await page.locator('main').innerText(),/Renamed Operation/);
    const row=(await database.query(`SELECT w.name FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id
      WHERE a.email='settings@example.test'`)).rows[0];assert.equal(row.name,'Renamed Operation');assert.deepEqual(errors,[]);
  });
