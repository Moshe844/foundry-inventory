'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { chromium }=require('playwright');
const { startCluster }=require('../helpers/postgres-cluster');
const { openPostgres }=require('../../src/db/postgres');
const { migratePostgres }=require('../../src/db/migrate-postgres');
const { createPostgresApp }=require('../../src/postgres-app');

test('Chromium creates and switches isolated PostgreSQL inventories without a subscription gate',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-workspaces-ui'});
    await migratePostgres(database);const app=createPostgresApp({database,env:'test',sessionSecret:'workspace-ui-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(15000);
    const errors=[];page.on('pageerror',(error)=>errors.push(error.message));const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('First Operation');
    await page.getByLabel('Your name').fill('Workspace Owner');await page.getByLabel('Work email').fill('workspaces@example.test');
    await page.getByLabel('Password').fill('workspace-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const first=(await database.query(`SELECT w.id FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id
      WHERE a.email='workspaces@example.test'`)).rows[0].id;
    await database.query(`INSERT INTO items(id,workspace_id,name,base_code,tracking_mode,unit_label,allow_negative,is_active,created_at,updated_at)
      VALUES('workspace-one-item',$1,'Only In First','FIRST','quantity','unit',0,1,$2,$2)`,[first,'2026-09-23T00:00:00.000Z']);
    await page.goto(`${base}/inventories`);assert.match(await page.locator('main').innerText(),/First Operation.*1 products/s);
    await page.getByRole('link',{name:'New inventory'}).first().click();await page.getByLabel('Inventory name').fill('Second Operation');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Choose a source'}).click()]);
    assert.doesNotMatch(await page.locator('body').innerText(),/Only In First/);
    await page.goto(`${base}/inventories`);assert.match(await page.locator('main').innerText(),/First Operation.*1 products.*Second Operation.*0 products/s);
    const firstRow=page.locator('.rm-row').filter({hasText:'First Operation'});await Promise.all([page.waitForURL(`${base}/`),
      firstRow.getByRole('button',{name:'Open'}).click()]);
    await page.goto(`${base}/inventory`);
    assert.match(await page.locator('main').innerText(),/Only In First/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id
      WHERE a.email='workspaces@example.test'`)).rows[0].count,'2');assert.deepEqual(errors,[]);
  });
