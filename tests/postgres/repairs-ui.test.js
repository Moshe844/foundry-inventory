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
const inventory=require('../../src/domain/postgres-inventory-engine');
const connections=require('../../src/connections/postgres-service');
const providerSync=require('../../src/connections/postgres-provider-sync');
const eventIngestion=require('../../src/connections/postgres-event-ingestion');
const repairs=require('../../src/repairs/postgres-service');

test('real Chromium governs a PostgreSQL connector mapping repair without rewriting history',
  {timeout:180000},async context=>{
    const cluster=await startCluster();const database=openPostgres(cluster.connectionString,
      {applicationName:'stockchief-postgres-repairs-ui'});await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-repairs-secret'});
    const server=await new Promise(resolve=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();context.after(async()=>{await browser.close();
      await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();
      await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Repair Certification');
    await page.getByLabel('Your name').fill('Repair Owner');await page.getByLabel('Work email').fill('repairs-pg@example.test');
    await page.getByLabel('Password').fill('repairs-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts account ON account.id=u.account_id
      WHERE account.email='repairs-pg@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const location=await locations.createLocation(database,ctx,{name:'Repair warehouse',kind:'warehouse'});
    const oldItem=await catalog.createItem(database,ctx,{name:'Old mapped widget',baseCode:'OLD-MAP',trackingMode:'quantity'});
    const newItem=await catalog.createItem(database,ctx,{name:'Correct widget',baseCode:'RIGHT-MAP',trackingMode:'quantity'});
    const oldSku=oldItem.skuIds[0];const newSku=newItem.skuIds[0];
    await inventory.receive(database,ctx,{skuId:oldSku,locationId:location.id,quantity:5,idempotencyKey:'repair-old-opening'});
    await inventory.receive(database,ctx,{skuId:newSku,locationId:location.id,quantity:5,idempotencyKey:'repair-new-opening'});
    const feed=await connections.createFeed(database,ctx,{displayName:'Repair test connection'});
    await database.transaction(async client=>{
      const connection=(await client.query('SELECT * FROM workspace_connectors WHERE id=$1',[feed.connection.id])).rows[0];
      await providerSync.cacheRecord(client,connection,{entityType:'sku',externalId:'external-widget',
        code:'OLD-MAP',displayName:'External widget'});
      await providerSync.cacheRecord(client,connection,{entityType:'location',externalId:'external-warehouse',
        displayName:'Repair warehouse'});
    },{isolation:'SERIALIZABLE'});
    const auth=await connections.authenticate(database,`Bearer ${feed.token}`);
    await eventIngestion.ingest(database,auth,{eventId:'sale-before-repair',type:'sale.completed',
      data:{externalSkuId:'external-widget',externalLocationId:'external-warehouse',quantity:1}});
    const historical=(await database.query(`SELECT id,sku_id FROM movements WHERE workspace_id=$1
      AND reference='external:sale-before-repair'`,[ctx.workspaceId])).rows[0];
    assert.equal(historical.sku_id,oldSku);
    const mapping=(await database.query(`SELECT * FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2
      AND entity_type='sku' AND external_id='external-widget'`,[ctx.workspaceId,feed.connection.id])).rows[0];

    await page.goto(`${base}/everything`);await page.getByRole('link',{name:'Governed repairs'}).click();
    await page.getByRole('link',{name:'Report something wrong'}).click();
    await page.getByLabel('Which connected product is wrong?').selectOption(mapping.id);
    await page.getByLabel('Which StockChief product should it use?').selectOption(newSku);
    await page.getByLabel(/What made you notice/).fill('Provider sales are landing on the retired catalogue record.');
    await Promise.all([page.waitForURL(/\/repairs\/repair_/),page.getByRole('button',{name:'Diagnose this mismatch'}).click()]);
    const repairId=page.url().split('/').pop();
    assert.match(await page.locator('main').innerText(),/Future imported activity[\s\S]*Correct widget[\s\S]*Historical business records are not rewritten/i);
    assert.equal((await database.query('SELECT foundry_record_id FROM connection_mappings WHERE id=$1',[mapping.id])).rows[0].foundry_record_id,oldSku);
    assert.equal((await database.query('SELECT status FROM repair_cases WHERE id=$1',[repairId])).rows[0].status,'NEEDS_AUTHORITY');

    await page.goto(`${base}/needs-you`);const needsText=await page.locator('main').innerText();
    assert.match(needsText,/external-widget is connected to the wrong StockChief product/i);
    assert.match(needsText,/Review repair/i);
    await page.getByRole('link',{name:'Review repair'}).click();
    await Promise.all([page.waitForURL(`${base}/repairs/${repairId}`),page.getByRole('button',{name:'Approve this repair'}).click()]);
    assert.match(await page.locator('main').innerText(),/approved[\s\S]*No business record has changed yet/i);
    assert.equal((await database.query('SELECT foundry_record_id FROM connection_mappings WHERE id=$1',[mapping.id])).rows[0].foundry_record_id,oldSku);
    await Promise.all([page.waitForURL(`${base}/repairs/${repairId}`),page.getByRole('button',{name:'Run and verify repair'}).click()]);
    const resolvedText=await page.locator('main').innerText();
    assert.match(resolvedText,/RESOLVED/i);assert.match(resolvedText,/Passed:[\s\S]*Future external activity resolves/i);
    assert.equal((await database.query('SELECT foundry_record_id FROM connection_mappings WHERE id=$1',[mapping.id])).rows[0].foundry_record_id,newSku);
    assert.equal((await database.query('SELECT sku_id FROM movements WHERE id=$1',[historical.id])).rows[0].sku_id,oldSku);
    const replay=await repairs.execute(database,ctx,repairId);assert.equal(replay.replayed,true);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM repair_case_events WHERE repair_case_id=$1
      AND event='domain_action_completed'`,[repairId])).rows[0].count,'1');

    await eventIngestion.ingest(database,auth,{eventId:'sale-after-repair',type:'sale.completed',
      data:{externalSkuId:'external-widget',externalLocationId:'external-warehouse',quantity:1}});
    assert.equal((await database.query(`SELECT sku_id FROM movements WHERE workspace_id=$1
      AND reference='external:sale-after-repair'`,[ctx.workspaceId])).rows[0].sku_id,newSku);
    await page.goto(`${base}/needs-you`);assert.doesNotMatch(await page.locator('main').innerText(),/external-widget is connected/i);
  });
