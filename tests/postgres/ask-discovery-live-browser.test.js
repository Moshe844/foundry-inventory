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
const catalog=require('../../src/domain/postgres-catalog-service');

test('real Chromium and reasoning model discover actual capabilities without business mutation',
  {skip:process.env.STOCKCHIEF_ASK_DISCOVERY_BROWSER!=='1',timeout:180000},async(context)=>{
    assert.ok(config.ai.configured,'The opt-in browser test needs a configured model provider.');
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-ask-discovery-browser'});
    await migratePostgres(database);
    const aiProvider=createProviderUnobserved(config.ai.provider,config.ai.tier('fast'));
    const app=createPostgresApp({database,env:'test',sessionSecret:'ask-discovery-browser-secret',aiProvider});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const page=await browser.newPage();
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Discovery Browser Business');
    await page.getByLabel('Your name').fill('Discovery Owner');
    await page.getByLabel('Work email').fill('discovery-browser@example.test');
    await page.getByLabel('Password').fill('isolated-discovery-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    await page.goto(`${base}/ask`);
    assert.equal(await page.getByText('What can you help me do here?',{exact:true}).count(),1);
    assert.equal(await page.getByText('Help me email a supplier',{exact:true}).count(),0,
      'unconnected email must not be suggested');
    await page.getByText('What can you help me do here?',{exact:true}).click();
    assert.equal(await page.getByLabel('Ask StockChief').inputValue(),'What can you help me do here?');
    await page.getByLabel('Ask StockChief').fill('I am new here. What can you help me do in this business?');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    const reply=await page.locator('.rm-turn--latest + .rm-turn--foundry').innerText();
    assert.match(reply,/I can help you/i);
    assert.match(reply,/approval|records you are allowed to see/i);
    assert.doesNotMatch(reply,/carrier label|bank transfer|AI email draft/i);
    const proposals=(await database.query('SELECT COUNT(*)::int AS total FROM stockchief_runtime.assistant_action_proposals')).rows[0];
    assert.equal(proposals.total,0);
    await Promise.all([page.waitForURL(`${base}/ask`),page.getByRole('button',{name:'New conversation'}).click()]);
    await page.getByLabel('Ask StockChief').fill('Arrange for $150 to leave our bank account and pay a supplier now.');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    const unsupported=await page.locator('.rm-turn--latest + .rm-turn--foundry').innerText();
    assert.match(unsupported,/cannot complete|could not safely match/i);
    assert.doesNotMatch(unsupported,/approved|sent the payment|payment completed/i);
    assert.doesNotMatch(unsupported,/reply below to continue|needs an answer from you/i);
    assert.equal((await database.query('SELECT COUNT(*)::int AS total FROM stockchief_runtime.assistant_action_proposals')).rows[0].total,0);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id WHERE w.name='Discovery Browser Business'`)).rows[0];
    const item=await catalog.createItem(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},
      {name:'Browser Clamp',trackingMode:'quantity'});
    await page.goto(`${base}/inventory/${item.itemId}`);
    await page.getByRole('link',{name:'Ask about this product'}).click();
    assert.equal(await page.locator('input[name="sourcePath"]').inputValue(),`/inventory/${item.itemId}`);
    assert.match(await page.getByLabel('Ask StockChief').inputValue(),/Browser Clamp/);
    context.diagnostic(`Browser discovery reply: ${reply.slice(0,320).replace(/\s+/g,' ')}`);
    context.diagnostic(`Unsupported bank-transfer reply: ${unsupported.slice(0,240).replace(/\s+/g,' ')}`);
  });
