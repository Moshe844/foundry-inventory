'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');

test('real Chromium global search resolves PostgreSQL business records quickly without crossing inventories',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-search-ui'});
    await migratePostgres(database);const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-search-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Search Certification');
    await page.getByLabel('Your name').fill('Search Owner');await page.getByLabel('Work email').fill('search-pg@example.test');
    await page.getByLabel('Password').fill('search-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w JOIN users u ON u.workspace_id=w.id
      JOIN accounts account ON account.id=u.account_id WHERE account.email='search-pg@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const item=await catalog.createItem(database,ctx,{name:'Copper Coupling',baseCode:'COPPER-COUPLING',trackingMode:'quantity'});
    await locations.createLocation(database,ctx,{name:'North Search Warehouse',kind:'warehouse'});
    await page.goto(`${base}/inventory`);await page.locator('[data-search]').fill('COPPER-COUPLING');
    const result=page.locator('[data-search-results] a').first();await result.waitFor();
    assert.match(await result.innerText(),/Copper Coupling[\s\S]*Product/);assert.equal(await result.getAttribute('href'),`/inventory/${item.itemId}#sku-${item.skuIds[0]}`);
    await result.click();await page.waitForURL(new RegExp(`/inventory/${item.itemId}`));
    assert.match(await page.locator('main').innerText(),/Copper Coupling/);
    await page.goto(`${base}/search?q=North%20Search`);assert.match(await page.locator('main').innerText(),/North Search Warehouse[\s\S]*Location/);
    const cross=(await database.query(`INSERT INTO workspaces(id,name,created_at) VALUES('other-search-workspace','Other Search','2026-09-23T00:00:00.000Z') RETURNING id`)).rows[0];
    await database.query(`INSERT INTO items(id,workspace_id,name,tracking_mode,unit_label,is_active,has_variants,allow_negative,created_at,updated_at)
      VALUES('other-secret-item',$1,'Other Tenant Secret','quantity','unit',1,0,0,'2026-09-23T00:00:00.000Z','2026-09-23T00:00:00.000Z')`,[cross.id]);
    await database.query(`INSERT INTO skus(id,workspace_id,item_id,code,is_default,position,is_active,created_at)
      VALUES('other-secret-sku',$1,'other-secret-item','OTHER-SECRET',1,0,1,'2026-09-23T00:00:00.000Z')`,[cross.id]);
    await page.goto(`${base}/search?q=Other%20Tenant%20Secret`);assert.match(await page.locator('main').innerText(),/Nothing matched/);
  });
