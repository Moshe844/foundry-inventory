'use strict';

// Opt-in certification: an unscripted model plans against a fresh business in
// Chromium. This file deliberately has no model or provider-response fixture.
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
const plans=require('../../src/assistant/postgres-capability-plans');

test('live browser certifies a novel multi-step goal, memory, and human interaction count',
  {skip:!config.ai.configured,timeout:600000},async(t)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'autonomous-independent-certification'});
    await migratePostgres(database);
    const provider=createProviderUnobserved(config.ai.provider,config.ai.tier('fast'));
    const app=createPostgresApp({database,env:'test',sessionSecret:'independent-autonomy-certification',
      aiProvider:provider});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    t.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const suffix=crypto.randomBytes(3).toString('hex').toUpperCase();
    const business=`Alder Cycle Repair ${suffix}`;
    const product=`Brake Cable Kit ${suffix}`;
    const sku=`BRAKE-CABLE-${suffix}`;
    const warehouse=`North Parts Room ${suffix}`;
    const reference=`DELIVERY-${suffix}`;
    const quantity=5+Number.parseInt(suffix.slice(0,1),16)%7;
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.setDefaultTimeout(30000);
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill(business);
    await page.getByLabel('Your name').fill('Alder Owner');
    await page.getByLabel('Work email').fill(`owner-${suffix.toLowerCase()}@alder.example.test`);
    await page.locator('input[name="password"]').fill('isolated-certification-password');
    if(await page.locator('input[name="confirmPassword"]').count())
      await page.locator('input[name="confirmPassword"]').fill('isolated-certification-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),
      page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id AND u.role='owner' WHERE w.name=$1`,[business])).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const place=await locations.createLocation(database,ctx,{name:warehouse,kind:'warehouse'});
    const goal=`We have started stocking ${product} under SKU ${sku}. Set it up in our inventory, `+
      `then record the ${quantity} units that physically arrived in ${warehouse} on receiving note ${reference}.`;
    await page.goto(`${base}/ask`);
    await page.getByLabel('Ask StockChief').fill(goal);
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    const firstReply=(await page.locator('main').innerText()).slice(-1800);
    const mission=(await database.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
    t.diagnostic(`First Ask reply: ${firstReply.replace(/\s+/g,' ').slice(0,600)}`);
    assert.ok(mission,`The real model did not prepare a multi-step mission. ${firstReply}`);
    assert.ok(mission.steps.length>=2,`Unexpected plan: ${JSON.stringify(mission.steps)}`);
    assert.ok(mission.steps.some((step)=>step.capability==='catalog.create_item'));
    assert.ok(mission.steps.some((step)=>step.capability==='inventory.receive'));
    t.diagnostic(`Prepared plan: ${JSON.stringify(mission.steps.map((step)=>step.capability))}`);
    await page.getByRole('link',{name:'Review prepared change'}).click();
    assert.match(await page.locator('main').innerText(),/One outcome, one approval/i);
    await Promise.all([page.waitForURL(/\/ask#latest$/),
      page.getByRole('button',{name:'Approve the whole mission'}).click()]);
    const completed=(await database.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,mission.id])).rows[0];
    const stock=(await database.query(`SELECT s.code,b.on_hand FROM skus s JOIN balances b
      ON b.workspace_id=s.workspace_id AND b.sku_id=s.id
      WHERE s.workspace_id=$1 AND s.code=$2 AND b.location_id=$3`,
    [ctx.workspaceId,sku,place.id])).rows[0];
    assert.equal(completed.status,'DONE',JSON.stringify(completed.steps));
    assert.equal(completed.verification_status,'VERIFIED');
    assert.equal(Number(stock?.on_hand),quantity);
    const receipt=(await database.query(`SELECT reference,quantity_delta FROM movements
      WHERE workspace_id=$1 AND location_id=$2 AND reference=$3`,
    [ctx.workspaceId,place.id,reference])).rows[0];
    assert.equal(Number(receipt?.quantity_delta),quantity,'The original receiving note must be persisted.');
    const remembered=(await database.query(`SELECT memory_type,confidence,provenance FROM
      stockchief_runtime.assistant_business_memory WHERE workspace_id=$1 AND memory_type='OUTCOME'`,
    [ctx.workspaceId])).rows;
    assert.equal(remembered.length,2);
    assert.ok(remembered.every((entry)=>entry.confidence==='VERIFIED'
      &&entry.provenance?.kind==='assistant_action_proposal'));
    const summary=await plans.metricsSummary(database,ctx.workspaceId);
    t.diagnostic(`Measured outcomes: ${JSON.stringify(summary)}`);
    assert.equal(summary.completed,1);
    assert.equal(summary.approvals,1);
    assert.equal(summary.automatic_steps,1);
    assert.equal(summary.humanInteractionsPerCompleted,2);
    await page.getByLabel('Ask StockChief').fill(`How many ${product} do we have in ${warehouse}, `+
      `and what receiving note established that amount?`);
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    const followUp=await page.locator('.rm-turn--latest + .rm-turn--foundry').innerText();
    t.diagnostic(`Memory follow-up: ${followUp.replace(/\s+/g,' ').slice(0,500)}`);
    assert.match(followUp,new RegExp(String(quantity)));
    assert.match(followUp,new RegExp(reference));
  });
