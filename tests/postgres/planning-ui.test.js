'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startCluster } = require('../helpers/postgres-cluster');
const { openPostgres } = require('../../src/db/postgres');
const { migratePostgres } = require('../../src/db/migrate-postgres');
const { createPostgresApp } = require('../../src/postgres-app');
const catalog = require('../../src/domain/postgres-catalog-service');
const locations = require('../../src/domain/postgres-location-service');
const inventory = require('../../src/domain/postgres-inventory-engine');
const pricing = require('../../src/pricing/postgres-service');

async function register(page, base, business, email) {
  await page.goto(`${base}/register`);
  await page.getByLabel('Business name').fill(business);
  await page.getByLabel('Your name').fill(`${business} Owner`);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('planning-password');
  await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
}

test('real Chromium plans shortages, transfers, excess and governed policy changes on PostgreSQL',
  { timeout:180000 }, async context => {
    const cluster = await startCluster();
    const database = openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-planning-ui'});
    await migratePostgres(database);
    const app = createPostgresApp({database,env:'test',sessionSecret:'postgres-planning-secret'});
    const server = await new Promise(resolve => { const started=app.listen(0,'127.0.0.1',()=>resolve(started)); });
    const browser = await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const owner=await browser.newPage({viewport:{width:1440,height:1000}});owner.setDefaultTimeout(15000);
    await register(owner,base,'Planning Certification','planning-pg@example.test');
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts account ON account.id=u.account_id
      WHERE account.email='planning-pg@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const main=await locations.createLocation(database,ctx,{name:'Main warehouse',kind:'warehouse'});
    const overflow=await locations.createLocation(database,ctx,{name:'Overflow warehouse',kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:'Planning Widget',baseCode:'PLAN-WIDGET',trackingMode:'quantity'});
    const skuId=item.skuIds[0];
    await inventory.receive(database,ctx,{skuId,locationId:main.id,quantity:20,idempotencyKey:'planning-main-opening'});
    await inventory.issue(database,ctx,{skuId,locationId:main.id,quantity:18,idempotencyKey:'planning-main-demand'});
    await inventory.receive(database,ctx,{skuId,locationId:overflow.id,quantity:50,idempotencyKey:'planning-overflow-opening'});
    await pricing.setPurchaseCost(database,ctx,{skuId,amount:'5.00',currency:'USD',source:'certification'});

    const outsider=await browser.newPage();
    await register(outsider,base,'Other Business','planning-other@example.test');
    const other=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts account ON account.id=u.account_id
      WHERE account.email='planning-other@example.test'`)).rows[0];
    await catalog.createItem(database,{workspaceId:other.workspace_id,actorId:other.actor_id},
      {name:'Tenant Secret Product',baseCode:'TENANT-SECRET',trackingMode:'quantity'});

    await owner.goto(`${base}/inventory`);
    await owner.getByRole('link',{name:'What happens next'}).click();
    await owner.waitForURL(`${base}/planning`);
    const text=await owner.locator('main').innerText();
    assert.match(text,/Evidence-based planning/i);
    assert.match(text,/Planning Widget · PLAN-WIDGET/i);
    assert.match(text,/Main warehouse[\s\S]*2[\s\S]*0[\s\S]*18 issued \/ 90 days/i);
    assert.match(text,/Move 3 Planning Widget · PLAN-WIDGET from Overflow warehouse to Main warehouse/i);
    assert.doesNotMatch(text,/Tenant Secret Product|TENANT-SECRET/);
    const recommendation=await database.query(`SELECT id,recommended_value FROM planning_recommendations
      WHERE workspace_id=$1 AND sku_id=$2 AND status='OPEN'`,[ctx.workspaceId,skuId]);
    assert.equal(recommendation.rows.length,1);
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM reorder_policies WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].count,'0');
    const recommended=Number(recommendation.rows[0].recommended_value);
    await Promise.all([owner.waitForURL(`${base}/planning#recommendations`),owner.getByRole('button',{name:`Use ${recommended}`}).click()]);
    const policy=(await database.query(`SELECT reorder_point,source,notes FROM reorder_policies
      WHERE workspace_id=$1 AND sku_id=$2 AND location_id IS NULL`,[ctx.workspaceId,skuId])).rows[0];
    assert.equal(Number(policy.reorder_point),recommended);assert.equal(policy.source,'foundry');
    assert.match(policy.notes,/Approved planning recommendation/);
    assert.equal((await database.query('SELECT status FROM planning_recommendations WHERE id=$1',[recommendation.rows[0].id])).rows[0].status,'APPLIED');

    await owner.getByLabel('Availability preference').selectOption('protective');
    await owner.getByLabel('Maximum days of supply').fill('120');
    await owner.getByLabel('Inventory investment limit').fill('1000.00');
    await owner.getByLabel('Cash reserve').fill('250.00');
    await Promise.all([owner.waitForURL(`${base}/planning#goals`),owner.getByRole('button',{name:'Save planning goals'}).click()]);
    assert.equal(await owner.getByLabel('Availability preference').inputValue(),'protective');
    assert.equal(await owner.getByLabel('Maximum days of supply').inputValue(),'120');
    const stored=(await database.query(`SELECT key,value FROM operational_preferences WHERE workspace_id=$1
      AND key=ANY($2::text[]) ORDER BY key`,[ctx.workspaceId,['service_level','max_days_of_supply','inventory_cap_minor','cash_reserve_minor']])).rows;
    assert.equal(stored.length,4);
    assert.deepEqual(Object.fromEntries(stored.map(row=>[row.key,JSON.parse(row.value).value])),{
      cash_reserve_minor:25000,inventory_cap_minor:100000,max_days_of_supply:120,service_level:'protective',
    });
  });
