'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {chromium}=require('playwright');
const config=require('../../src/config');
const {createProviderUnobserved}=require('../../src/ai/provider');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const locations=require('../../src/domain/postgres-location-service');
const imports=require('../../src/imports/postgres-service');
const worker=require('../../src/operations/postgres-worker');
const scheduler=require('../../src/operations/postgres-scheduler');
const runtime=require('../../src/operations/postgres-runtime-handlers');
const plans=require('../../src/assistant/postgres-capability-plans');

test('real model and browser complete one approved import mission after an actual worker event',
  {skip:!config.ai.configured,timeout:600000},async(t)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'autonomous-import-live-certification'});
    await migratePostgres(database);
    const provider=createProviderUnobserved(config.ai.provider,config.ai.tier('fast'));
    const app=createPostgresApp({database,env:'test',sessionSecret:'autonomous-import-live-certification',
      aiProvider:provider});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();let workerRun=null;let schedulerRun=null;
    t.after(async()=>{if(schedulerRun)await schedulerRun.stop();if(workerRun)await workerRun.stop();
      await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const suffix=crypto.randomBytes(3).toString('hex').toUpperCase();
    const business=`Juniper Kitchen Supply ${suffix}`;
    const item=`Stainless Ladle ${suffix}`;const sku=`LADLE-${suffix}`;
    const location=`Catering Store ${suffix}`;const filename=`juniper-count-${suffix}.csv`;
    const quantity=6+Number.parseInt(suffix.slice(0,1),16)%5;
    const page=await browser.newPage();page.setDefaultTimeout(30000);
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill(business);
    await page.getByLabel('Your name').fill('Juniper Owner');
    await page.getByLabel('Work email').fill(`juniper-${suffix.toLowerCase()}@example.test`);
    await page.locator('input[name="password"]').fill('isolated-certification-password');
    if(await page.locator('input[name="confirmPassword"]').count())
      await page.locator('input[name="confirmPassword"]').fill('isolated-certification-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),
      page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id AND u.role='owner' WHERE w.name=$1`,[business])).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    await locations.createLocation(database,ctx,{name:location,kind:'warehouse'});
    const preview=await imports.analyse(database,ctx,{text:`Product,SKU,Location,Quantity\n${item},${sku},${location},${quantity}\n`,
      filename});
    assert.equal(preview.status,'READY');
    await page.goto(`${base}/ask`);
    await page.getByLabel('Ask StockChief').fill(`Finish the reviewed ${filename} inventory upload. `+
      'Approve its current preview, apply it, and verify the stock is recorded.');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    const mission=(await database.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
    t.diagnostic(`Prepared import plan: ${JSON.stringify(mission?.steps?.map((step)=>step.capability)||null)}`);
    assert.ok(mission,`Ask did not prepare a multi-step mission: ${(await page.locator('main').innerText()).slice(-1000)}`);
    assert.ok(mission.steps.some((step)=>step.capability==='import.approve'));
    assert.ok(mission.steps.some((step)=>step.capability==='import.run'));
    await page.getByRole('link',{name:'Review prepared change'}).click();
    await Promise.all([page.waitForURL(/\/ask#latest$/),
      page.getByRole('button',{name:'Approve the whole mission'}).click()]);
    const waiting=(await database.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,mission.id])).rows[0];
    t.diagnostic(`Mission after one approval: ${waiting.status}; steps=${JSON.stringify(waiting.steps.map((step)=>step.state))}`);
    assert.equal(waiting.status,'WAITING_EVENT');
    workerRun=worker.start(database,{handlers:runtime.create(),intervalMs:100,
      onError(error){t.diagnostic(`Worker error: ${error.code||error.message}`);}});
    schedulerRun=scheduler.start(database,{intervalMs:10000,
      onError(error){t.diagnostic(`Scheduler error: ${error.code||error.message}`);}});
    const deadline=Date.now()+60000;let completed;
    while(Date.now()<deadline){
      completed=(await database.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,mission.id])).rows[0];
      if(['DONE','BLOCKED','WAITING_USER'].includes(completed.status))break;
      await new Promise((resolve)=>setTimeout(resolve,500));
    }
    const importRow=(await database.query('SELECT status FROM import_plans WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,preview.id])).rows[0];
    const stock=(await database.query(`SELECT COALESCE(SUM(b.on_hand),0)::int AS quantity FROM skus s
      JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id
      WHERE s.workspace_id=$1 AND s.code=$2`,[ctx.workspaceId,sku])).rows[0];
    const summary=await plans.metricsSummary(database,ctx.workspaceId);
    t.diagnostic(`After worker and scheduler: mission=${completed.status}, import=${importRow.status}, `+
      `stock=${stock.quantity}, interactions=${summary.humanInteractionsPerCompleted}, `+
      `resumptions=${completed.metrics.resumptions}`);
    await page.goto(`${base}/ask`);
    assert.equal(completed.status,'DONE',JSON.stringify(completed.steps));
    assert.equal(completed.verification_status,'VERIFIED');
    assert.equal(importRow.status,'SUCCEEDED');
    assert.equal(stock.quantity,quantity);
    assert.equal(completed.metrics.approvalInteractions,1);
    assert.equal(completed.metrics.resumptions,1);
    assert.equal(summary.humanInteractionsPerCompleted,2);
  });
