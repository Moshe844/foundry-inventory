'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const locations=require('../../src/domain/postgres-location-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const reconciliation=require('../../src/operations/postgres-reconciliation');
const autonomy=require('../../src/autopilot/postgres-service');

test('browser exposes reconciliation stop and recovery for a real stock mismatch',
  {timeout:180000},async(t)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'autonomous-reconciliation-certification'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'autonomous-reconciliation-certification'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    t.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const suffix=crypto.randomBytes(3).toString('hex').toUpperCase();
    const business=`Lighthouse Hardware ${suffix}`;
    const page=await browser.newPage();page.setDefaultTimeout(20000);
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill(business);
    await page.getByLabel('Your name').fill('Lighthouse Owner');
    await page.getByLabel('Work email').fill(`lighthouse-${suffix.toLowerCase()}@example.test`);
    await page.locator('input[name="password"]').fill('isolated-certification-password');
    if(await page.locator('input[name="confirmPassword"]').count())
      await page.locator('input[name="confirmPassword"]').fill('isolated-certification-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),
      page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id AND u.role='owner' WHERE w.name=$1`,[business])).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const place=await locations.createLocation(database,ctx,{name:`Main Bay ${suffix}`,kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:`Lock Cylinder ${suffix}`,
      baseCode:`LOCK-${suffix}`,trackingMode:'quantity'});
    await inventory.receive(database,ctx,{skuId:item.skuIds[0],locationId:place.id,quantity:7,
      reference:`OPENING-${suffix}`,idempotencyKey:`certification:${suffix}`});
    await page.goto(`${base}/inventory/${item.itemId}`);
    assert.match(await page.locator('main').innerText(),/Lock Cylinder/i);
    assert.equal((await reconciliation.run(database,ctx.workspaceId)).status,'VERIFIED');
    // Fault injection imitates a storage or integration defect, not a business
    // operation. The immutable movement ledger remains authoritative evidence.
    await database.query(`UPDATE balances SET on_hand=on_hand+1
      WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
    [ctx.workspaceId,item.skuIds[0],place.id]);
    const broken=await reconciliation.run(database,ctx.workspaceId);
    assert.equal(broken.status,'FAILED');
    assert.ok(broken.checks.some((check)=>check.key==='inventory.balance_equals_movements'
      &&check.status==='FAIL'));
    const initialState=await autonomy.getState(database,ctx.workspaceId);
    t.diagnostic(`Fresh business suspended after reconciliation failure: ${initialState.suspended}`);
    // The first read creates the optional autopilot row. Check whether the
    // subsequent reconciliation can suspend it and tell the owner why.
    assert.equal((await reconciliation.run(database,ctx.workspaceId)).status,'FAILED');
    assert.equal((await autonomy.getState(database,ctx.workspaceId)).suspended,true);
    await page.goto(`${base}/autopilot`);
    const stoppedPage=await page.locator('main').innerText();
    const stopVisible=/reconciliation|suspended|automatic work is stopped/i.test(stoppedPage);
    t.diagnostic(`Reconciliation failure visible in Autopilot UI: ${stopVisible}`);
    await database.query(`UPDATE balances SET on_hand=on_hand-1
      WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
    [ctx.workspaceId,item.skuIds[0],place.id]);
    const restored=await reconciliation.run(database,ctx.workspaceId);
    assert.equal(restored.status,'VERIFIED');
    assert.equal((await autonomy.getState(database,ctx.workspaceId)).suspended,false);
    assert.equal(initialState.suspended,true,
      'A material mismatch must suspend a fresh business before it opens Autopilot.');
    assert.equal(stopVisible,true,'An owner must see why automatic work stopped.');
  });
