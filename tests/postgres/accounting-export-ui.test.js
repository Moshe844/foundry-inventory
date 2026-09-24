'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const ledger=require('../../src/accounting/postgres-ledger');
const jobs=require('../../src/operations/postgres-job-queue');
const runtimeHandlers=require('../../src/operations/postgres-runtime-handlers');

test('real Chromium governs PostgreSQL accounting export and a worker posts each journal exactly once',
  {timeout:240000},async(context)=>{
    let providerWrites=0;let mode='success';const posted=[];
    const adapter={integrationClass:'accounting',
      metadata(){return {type:'quickbooks',name:'QuickBooks Fixture',mark:'QB',category:'accounting',authMode:'oauth',
        available:true,description:'Certified accounting fixture.',provides:['accounting evidence']};},
      authorizationUrl({state,input}){const origin=new URL(input.redirectUri).origin;return {
        url:`${origin}/fixture-books-consent?callback=${encodeURIComponent(input.redirectUri)}&state=${encodeURIComponent(state)}`,
        metadata:{redirectUri:input.redirectUri}};},
      async exchangeAuthorization(){return {credentials:{accessToken:'encrypted-fixture',realmId:'realm-fixture'},
        accountId:'realm-fixture',accountName:'Fixture Books',capabilities:['accounting:read','accounting:post'],
        verifiedFact:{label:'QuickBooks company',value:'Fixture Books',externalId:'realm-fixture'}};},
      async readAccountingSnapshot(){return {asOf:'2026-09-23',currency:'USD',version:'fixture-v1',accounts:[
        {externalId:'ext-cash',code:'1000',name:'Cash',balanceMinor:100,version:'1'},
        {externalId:'ext-expense',code:'6000',name:'Operating expense',balanceMinor:-100,version:'1'},
      ]};},
      async postJournalEntry({entry,idempotencyKey}){providerWrites+=1;posted.push({entry,idempotencyKey});
        if(mode==='ambiguous')throw Object.assign(new Error('Provider timed out after submission.'),{code:'provider_timeout'});
        return {externalId:`qb-journal-${entry.entry_number}`,version:'1'};},
    };
    const providers={get(type){return type==='quickbooks'?adapter:null;},catalog(){return [adapter.metadata()];}};
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-accounting-export-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-accounting-export-secret',
      connectionProviders:providers});
    app.get('/fixture-books-consent',(req,res)=>res.send(`<!doctype html><html><body><main><h1>Fixture Books</h1>
      <a href="${req.query.callback}?code=fixture-code&amp;state=${encodeURIComponent(req.query.state)}">Authorize Fixture Books</a>
      </main></body></html>`));
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch({args:['--disable-popup-blocking']});const browserContext=await browser.newContext();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browserContext.newPage({viewport:{width:1440,height:1000}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Accounting Export Certification');
    await page.getByLabel('Your name').fill('Books Owner');await page.getByLabel('Work email').fill('books-pg@example.test');
    await page.getByLabel('Password').fill('books-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='books-pg@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    await ledger.configure(database,ctx,{startDate:'2026-09-01',currency:'USD'});
    const journal=await ledger.post(database,ctx,{postingDate:'2026-09-23',sourceKey:'accounting-export-fixture',
      description:'Certification journal',sourceType:'manual_certification',createdByType:'USER',lines:[
        {accountKey:'CASH',debitMinor:100},{accountKey:'OPERATING_EXPENSE',creditMinor:100},
      ]});

    await page.goto(`${base}/settings/connections`);const popupPromise=browserContext.waitForEvent('page');
    await page.getByRole('link',{name:'Connect QuickBooks Fixture'}).click();const popup=await popupPromise;
    await popup.waitForURL(/fixture-books-consent/);await popup.getByRole('link',{name:'Authorize Fixture Books'}).click();
    await page.waitForURL(/\/settings\/connections\/con_/);const connectionUrl=page.url();
    assert.match(await page.locator('main').innerText(),/Accounting control/);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Request governed posting'}).click()]);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Run read-only shadow comparison'}).click()]);
    assert.match(await page.locator('main').innerText(),/2 accounting difference/);
    const cashId=(await database.query(`SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND system_key='CASH'`,
      [ctx.workspaceId])).rows[0].id;
    const expenseId=(await database.query(`SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND system_key='OPERATING_EXPENSE'`,
      [ctx.workspaceId])).rows[0].id;
    for(const [accountId,externalId] of [[cashId,'ext-cash'],[expenseId,'ext-expense']]){
      await page.getByLabel('StockChief account').selectOption(accountId);
      await page.getByLabel('Provider account').selectOption(externalId);
      await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save exact mapping'}).click()]);
    }
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Run read-only shadow comparison'}).click()]);
    assert.match(await page.locator('main').innerText(),/Shadow comparison matched exactly/);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Enable verified posting'}).click()]);
    assert.match(await page.locator('main').innerText(),/WRITE ENABLED/i);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Queue ready journals'}).click()]);
    assert.equal(providerWrites,0);assert.match(await page.locator('main').innerText(),/PENDING/);
    const runtime=runtimeHandlers.create(providers,{accountingCredentials:{accessToken:'worker-only'}});
    const completed=await jobs.processOne(database,runtime,{owner:'accounting-export-worker',leaseMs:30000});
    assert.equal(completed.status,'COMPLETED');assert.equal(providerWrites,1);
    assert.equal(posted[0].entry.id,journal.entry.id);
    assert.deepEqual(posted[0].entry.lines.map((line)=>line.external_account_id),['ext-cash','ext-expense']);
    assert.equal(await jobs.processOne(database,runtime,{owner:'accounting-export-worker',leaseMs:30000}),null);
    assert.equal(providerWrites,1);
    await page.goto(connectionUrl);assert.match(await page.locator('main').innerText(),/Confirmed exports\s*1/i);
    const identityRow=(await database.query(`SELECT * FROM accounting_external_identities
      WHERE workspace_id=$1 AND connector_id=(SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND provider_type='quickbooks')
        AND entity_type='journal_entry' AND foundry_record_id=$2`,[ctx.workspaceId,journal.entry.id])).rows[0];
    assert.equal(identityRow.external_id,`qb-journal-${journal.entry.entry_number}`);
    const uncertain=await ledger.post(database,ctx,{postingDate:'2026-09-23',sourceKey:'accounting-export-uncertain',
      description:'Uncertain certification journal',sourceType:'manual_certification',createdByType:'USER',lines:[
        {accountKey:'CASH',debitMinor:50},{accountKey:'OPERATING_EXPENSE',creditMinor:50},
      ]});
    mode='ambiguous';await page.goto(connectionUrl);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Queue ready journals'}).click()]);
    const stopped=await jobs.processOne(database,runtime,{owner:'accounting-export-worker',leaseMs:30000});
    assert.equal(stopped.status,'DEAD');assert.equal(providerWrites,2);
    assert.equal(await jobs.processOne(database,runtime,{owner:'accounting-export-worker',leaseMs:30000}),null);
    assert.equal(providerWrites,2);
    const uncertainState=(await database.query(`SELECT effect.status,
        (SELECT COUNT(*) FROM accounting_external_identities identity WHERE identity.workspace_id=effect.workspace_id
          AND identity.connector_id=effect.payload->>'connectorId' AND identity.entity_type='journal_entry'
          AND identity.foundry_record_id=$2) AS identities
      FROM stockchief_runtime.provider_effects effect WHERE effect.workspace_id=$1
        AND effect.kind='accounting.journal.export' AND effect.aggregate_id=$2`,
    [ctx.workspaceId,uncertain.entry.id])).rows[0];
    assert.deepEqual({status:uncertainState.status,identities:Number(uncertainState.identities)},
      {status:'AMBIGUOUS',identities:0});
    await page.goto(`${base}/needs-you`);assert.match(await page.locator('main').innerText(),
      /Verify accounting journal export with quickbooks/);
    assert.deepEqual(errors,[]);
  });
