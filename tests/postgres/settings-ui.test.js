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
    page.on('pageerror',(error)=>errors.push(`${page.url()}: ${error.message}`));const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Settings Operation');
    await page.getByLabel('Your name').fill('Settings Owner');await page.getByLabel('Work email').fill('settings@example.test');
    await page.getByLabel('Password').fill('settings-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    await page.goto(`${base}/what-you-told-me`);assert.match(await page.locator('main').innerText(),/haven't told me any standing rules yet/i);
    await page.goto(`${base}/everything`);const directory=await page.locator('main').innerText();
    assert.match(directory,/Full stock table/);assert.match(directory,/All connections/);
    assert.match(directory,/Picking and packing queue/);assert.match(directory,/Chart of accounts/);
    const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Export everything'}).click();
    const download=await downloadPromise;assert.match(download.suggestedFilename(),/^settings-operation-\d{4}-\d{2}-\d{2}\.json$/);
    const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);
    const exported=JSON.parse(Buffer.concat(chunks).toString('utf8'));assert.equal(exported.tables.workspaces[0].name,'Settings Operation');
    assert.equal(exported.tables.users.length,1);await page.goto(`${base}/everything`);
    const establishedRoutes=['/orders','/orders/new','/fulfilment','/sales/customers/new','/purchasing',
      '/purchasing/orders/new','/suppliers','/purchasing/setup','/inventory/table','/inventory/new','/locations',
      '/warehouse','/transfers','/planning','/pricing/new','/imports/start','/accounting/books',
      '/accounting/transactions','/accounting/chart','/accounting/receivables','/accounting/payables',
      '/accounting/banking','/accounting/periods','/accounting/tax','/accounting/reports/profit-and-loss',
      '/accounting/reports/balance-sheet','/mail','/activity','/autopilot','/autopilot/history','/actions',
      '/settings/connections','/settings/shipping','/search','/settings','/foundry','/inventories','/guide','/support'];
    for(const route of establishedRoutes){await page.goto(`${base}${route}`);const main=await page.locator('main').innerText();
      assert.doesNotMatch(main,/We could not find that|Internal Server Error/i,route);assert.notEqual(await page.title(),'Error',route);}
    await page.goto(`${base}/settings`);assert.match(await page.locator('main').innerText(),/technical side of this inventory/i);
    assert.match(await page.locator('main').innerText(),/Pre-subscription · unlimited/);
    await page.locator('#workspace-name').fill('Renamed Operation');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save',exact:true}).click()]);
    assert.equal(await page.locator('#workspace-name').inputValue(),'Renamed Operation');
    await page.getByRole('button',{name:'Add person'}).click();const person=page.locator('#modal-person');
    await person.getByLabel('Name').fill('Settings Accountant');await person.getByLabel('Email').fill('accountant@example.test');
    await person.getByLabel('Temporary password').fill('accountant-password');await person.getByLabel('Role').selectOption('accountant');
    await Promise.all([page.waitForNavigation(),person.getByRole('button',{name:'Add person'}).click()]);
    assert.match(await page.locator('main').innerText(),/Settings Accountant[\s\S]*Accountant/);
    const alerts=page.locator('form[action="/settings/email-alerts"]');await alerts.getByRole('checkbox').check();
    await alerts.getByLabel('Recipients').fill('owner-alerts@example.test');
    await Promise.all([page.waitForNavigation(),alerts.getByRole('button',{name:'Save email alerts'}).click()]);
    assert.match(await page.locator('main').innerText(),/Automatic email alerts are on|preferences are saved/i);
    await page.locator('#live-event-feed > summary').click();
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Connect live feed'}).click()]);
    assert.match(await page.locator('main').innerText(),/Copy this token now/);
    assert.match(await page.getByLabel('New event feed token').inputValue(),/^fnd_live_/);
    const row=(await database.query(`SELECT w.name FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id
      WHERE a.email='settings@example.test'`)).rows[0];assert.equal(row.name,'Renamed Operation');assert.deepEqual(errors,[]);
  });
