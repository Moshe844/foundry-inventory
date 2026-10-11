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
const plans=require('../../src/assistant/postgres-capability-plans');

test('real browser and model grant, remember, revoke, and reject conflicting supplier authority',
  {skip:!config.ai.configured,timeout:600000},async(t)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'autonomous-rule-live-certification'});
    await migratePostgres(database);
    const provider=createProviderUnobserved(config.ai.provider,config.ai.tier('fast'));
    const app=createPostgresApp({database,env:'test',sessionSecret:'autonomous-rule-live-certification',
      aiProvider:provider});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    t.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const suffix=crypto.randomBytes(3).toString('hex').toUpperCase();
    const business=`Moss Workshop ${suffix}`;
    const page=await browser.newPage();page.setDefaultTimeout(30000);
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill(business);
    await page.getByLabel('Your name').fill('Moss Owner');
    await page.getByLabel('Work email').fill(`moss-${suffix.toLowerCase()}@example.test`);
    await page.locator('input[name="password"]').fill('isolated-certification-password');
    if(await page.locator('input[name="confirmPassword"]').count())
      await page.locator('input[name="confirmPassword"]').fill('isolated-certification-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),
      page.getByRole('button',{name:'Create account'}).click()]);
    const workspaceId=(await database.query('SELECT id FROM workspaces WHERE name=$1',[business])).rows[0].id;
    async function ask(message){await page.goto(`${base}/ask`);
      await page.getByLabel('Ask StockChief').fill(message);
      await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
      return (await page.locator('main').innerText()).slice(-1100);}
    const grantReply=await ask('Permit StockChief to send supplier emails automatically for routine purchasing.');
    let instruction=(await database.query(`SELECT id,status,resolved_changes FROM operating_instruction_proposals
      WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`,[workspaceId])).rows[0];
    assert.ok(instruction,grantReply);
    assert.equal(instruction.status,'PENDING');
    assert.ok(JSON.parse(instruction.resolved_changes).some((change)=>change.domain==='capability_authority'
      &&change.capabilityName==='supplier_emails'&&change.operation==='set'),
    JSON.stringify(instruction.resolved_changes));
    await page.getByRole('link',{name:'Review prepared change'}).click();
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve standing rule'}).click()]);
    let authority=(await database.query(`SELECT granted FROM autopilot_capabilities
      WHERE workspace_id=$1 AND capability='supplier_emails'`,[workspaceId])).rows[0];
    assert.equal(Number(authority.granted),1);
    let memory=(await database.query(`SELECT confidence,retired_at FROM stockchief_runtime.assistant_business_memory
      WHERE workspace_id=$1 AND memory_key='authority:capability:supplier_emails'
      ORDER BY created_at DESC LIMIT 1`,[workspaceId])).rows[0];
    assert.equal(memory.confidence,'OWNER_STATED');assert.equal(memory.retired_at,null);
    const revokeReply=await ask('Revoke StockChief\'s standing permission to email suppliers automatically.');
    instruction=(await database.query(`SELECT id,status,resolved_changes FROM operating_instruction_proposals
      WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`,[workspaceId])).rows[0];
    assert.equal(instruction.status,'PENDING',revokeReply);
    assert.ok(JSON.parse(instruction.resolved_changes).some((change)=>change.domain==='capability_authority'
      &&change.capabilityName==='supplier_emails'&&change.operation==='remove'),
    JSON.stringify(instruction.resolved_changes));
    await page.getByRole('link',{name:'Review prepared change'}).click();
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve standing rule'}).click()]);
    authority=(await database.query(`SELECT granted FROM autopilot_capabilities
      WHERE workspace_id=$1 AND capability='supplier_emails'`,[workspaceId])).rows[0];
    memory=(await database.query(`SELECT retired_at FROM stockchief_runtime.assistant_business_memory
      WHERE workspace_id=$1 AND memory_key='authority:capability:supplier_emails'
      ORDER BY created_at DESC LIMIT 1`,[workspaceId])).rows[0];
    assert.equal(Number(authority.granted),0);
    assert.ok(memory.retired_at);
    const conflictReply=await ask('From now on, both allow StockChief to email suppliers automatically and never let it send supplier emails.');
    const pending=(await database.query(`SELECT resolved_changes FROM operating_instruction_proposals
      WHERE workspace_id=$1 AND status='PENDING'`,[workspaceId])).rows;
    t.diagnostic(`Conflicting instruction reply: ${conflictReply.replace(/\s+/g,' ').slice(0,500)}`);
    t.diagnostic(`Pending conflicting proposals: ${JSON.stringify(pending)}`);
    assert.equal(Number((await database.query(`SELECT granted FROM autopilot_capabilities
      WHERE workspace_id=$1 AND capability='supplier_emails'`,[workspaceId])).rows[0].granted),0);
    assert.equal(pending.length,0,'A contradictory standing instruction must not prepare a unilateral grant.');
    const measured=await plans.metricsSummary(database,workspaceId);
    assert.deepEqual(measured.breakdown.standingRules,{outcomes:2,completed:2});
    assert.equal(measured.humanInteractions,4);
    assert.equal(measured.humanInteractionsPerCompleted,2);
    t.diagnostic(`Mission metric after two completed standing-rule outcomes and four browser interactions: `+
      `${JSON.stringify({missions:measured.missions,completed:measured.completed,
        humanInteractionsPerCompleted:measured.humanInteractionsPerCompleted})}`);
  });
