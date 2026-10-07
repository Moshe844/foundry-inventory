'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const config=require('../../src/config');
const {createProviderUnobserved}=require('../../src/ai/provider');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');

test('live reasoning model and Chromium prepare, approve, and verify a supplier through Ask',
  {skip:process.env.STOCKCHIEF_ASK_LIVE_BROWSER!=='1',timeout:180000},async(context)=>{
    assert.ok(config.ai.configured,'This opt-in browser test requires a configured reasoning provider.');
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-ask-live-browser'});
    await migratePostgres(database);
    const aiProvider=createProviderUnobserved(config.ai.provider,config.ai.tier('fast'));
    const app=createPostgresApp({database,env:'test',sessionSecret:'ask-live-browser-secret',aiProvider});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const page=await browser.newPage();
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Meadow Fixtures');
    await page.getByLabel('Your name').fill('Meadow Owner');
    await page.getByLabel('Work email').fill('meadow-owner@example.test');
    await page.getByLabel('Password').fill('isolated-test-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const workspaceId=(await database.query("SELECT id FROM workspaces WHERE name='Meadow Fixtures'")).rows[0].id;
    await page.goto(`${base}/ask`);
    await page.getByLabel('Ask StockChief').fill('Put Meadow Materials in our supplier contacts. Their email is meadow@example.test.');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    const proposal=(await database.query(`SELECT id,status,payload FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 AND action_type='contact.create'`,[workspaceId])).rows[0];
    assert.ok(proposal,'Ask should prepare a supplier proposal in the browser.');
    assert.equal(proposal.status,'PENDING');
    assert.deepEqual({kind:proposal.payload.kind,name:proposal.payload.name,email:proposal.payload.email},
      {kind:'supplier',name:'Meadow Materials',email:'meadow@example.test'});
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM suppliers WHERE workspace_id=$1',
      [workspaceId])).rows[0].count,0,'Preparation must not create the supplier.');
    await page.goto(`${base}/actions/${proposal.id}`);
    await page.getByRole('button',{name:/approve/i}).click();
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM suppliers WHERE workspace_id=$1
      AND name='Meadow Materials' AND email='meadow@example.test'`,[workspaceId])).rows[0].count,1);
  });
