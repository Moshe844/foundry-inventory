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
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');

test('real Chromium governs PostgreSQL accounting export and a worker posts each journal exactly once',
  {timeout:240000},async(context)=>{
    let providerWrites=0,refreshes=0;let mode='success';const posted=[];
    const nativeQbo=require('../../src/connections/providers/quickbooks'),oldFetch=global.fetch,oldEnvironment=process.env.QUICKBOOKS_ENVIRONMENT,remoteJournals=new Map();process.env.QUICKBOOKS_ENVIRONMENT='sandbox';
    global.fetch=async(value,options={})=>{
      const url=new URL(value);
      if(url.hostname==='oauth.platform.intuit.com'){assert.equal(options.method,'POST');assert.equal(options.body.get('grant_type'),'refresh_token');assert.equal(options.body.get('refresh_token'),'encrypted-refresh-fixture');refreshes++;return Response.json({access_token:'refreshed-fixture',refresh_token:'encrypted-refresh-fixture',expires_in:3600});}
      assert.equal(url.hostname,'sandbox-quickbooks.api.intuit.com','The wire fixture must never call a real provider');
      if(options.method==='POST'&&url.pathname.endsWith('/journalentry')){const body=JSON.parse(options.body),source=posted.at(-1).entry,id='qb-journal-'+source.entry_number;assert.equal(body.CurrencyRef.value,'USD');assert(body.Line.every(l=>Number.isFinite(l.Amount)));remoteJournals.set(id,{...structuredClone(body),Id:id,SyncToken:'1'});return Response.json({JournalEntry:remoteJournals.get(id)});}
      const id=decodeURIComponent(url.pathname.split('/').pop()),read=structuredClone(remoteJournals.get(id));assert(read,'Read-back must resolve an existing separate provider record');
      if(mode==='verification_failed')read.Line[0].Amount+=0.01;return Response.json({JournalEntry:read});
    };
    context.after(()=>{global.fetch=oldFetch;if(oldEnvironment===undefined)delete process.env.QUICKBOOKS_ENVIRONMENT;else process.env.QUICKBOOKS_ENVIRONMENT=oldEnvironment;});
    const adapter={integrationClass:'accounting',
      metadata(){return {type:'quickbooks',name:'QuickBooks Fixture',mark:'QB',category:'accounting',authMode:'oauth',
        available:true,description:'Certified accounting fixture.',provides:['accounting evidence']};},
      authorizationUrl({state,input}){const origin=new URL(input.redirectUri).origin;return {
        url:`${origin}/fixture-books-consent?callback=${encodeURIComponent(input.redirectUri)}&state=${encodeURIComponent(state)}`,
        metadata:{redirectUri:input.redirectUri}};},
      async exchangeAuthorization(){return {credentials:{accessToken:'encrypted-fixture',refreshToken:'encrypted-refresh-fixture',expiresAt:new Date(Date.now()-3600000).toISOString(),realmId:'realm-fixture'},
        accountId:'realm-fixture',accountName:'Fixture Books',capabilities:['accounting:read','accounting:post'],
        verifiedFact:{label:'QuickBooks company',value:'Fixture Books',externalId:'realm-fixture'}};},
      async readAccountingSnapshot(){return {asOf:'2026-09-23',currency:'USD',version:'fixture-v1',accounts:[
        {externalId:'ext-cash',code:'1000',name:'Cash',balanceMinor:100,version:'1'},
        {externalId:'ext-expense',code:'6000',name:'Operating expense',balanceMinor:-100,version:'1'},
      ]};},
      async postJournalEntry({entry,idempotencyKey}){providerWrites+=1;posted.push({entry,idempotencyKey});
        if(mode==='ambiguous')throw Object.assign(new Error('Provider timed out after submission.'),{code:'provider_timeout'});
        return nativeQbo.postJournalEntry({credentials:{accessToken:'wire-fixture-only',realmId:'realm-fixture'},entry,idempotencyKey});},
      async verifyJournalEntry({entry,externalId}){assert(posted.some(p=>p.entry.id===entry.id));return nativeQbo.verifyJournalEntry({credentials:{accessToken:'wire-fixture-only',realmId:'realm-fixture'},entry,externalId});},
    };
    const providers={get(type){return type==='quickbooks'?adapter:null;},catalog(){return [adapter.metadata()];}};
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-accounting-export-ui'});
    await migratePostgres(database);
    const askPlans=new Map();
    const aiProvider={name:'anthropic',model:PRICED_MODEL,async complete(input){
      if(input.schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''},usage:pricedUsage()};
      const message=JSON.parse(input.prompt).message;
      assert.ok(askPlans.has(message),`No Ask fixture for ${message}`);
      const {capability,args}=askPlans.get(message);
      return {data:{steps:[{capability,arguments:Object.entries(args).map(([name,value])=>
        ({name,value:String(value)})),dependsOn:[],continuesPending:false}],clarifyingQuestion:''},usage:pricedUsage()};
    }};
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-accounting-export-secret',
      connectionProviders:providers,aiProvider});
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
    await page.locator('input[name="password"]').fill('books-password');if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('books-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='books-pg@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    async function askAndApprove(message,capability,args){
      askPlans.set(message,{capability,args});
      const prior=(await database.query('SELECT id FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[ctx.workspaceId])).rows[0]?.id;
      await page.goto(`${base}/ask`);await page.getByLabel('Ask StockChief').fill(message);
      // Ask now submits asynchronously. Assert its durable proposal rather
      // than requiring the browser to perform an obsolete full navigation.
      await page.getByRole('button',{name:'Continue'}).click();let proposal;
      for(let i=0;i<100;i++){proposal=(await database.query('SELECT * FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[ctx.workspaceId])).rows[0];if(proposal&&proposal.id!==prior)break;await new Promise(r=>setTimeout(r,100));}
      assert.notEqual(proposal?.id,prior,(await page.locator('main').innerText()).slice(0,1600));
      assert.equal(proposal?.action_type,capability,(await page.locator('main').innerText()).slice(0,1000));
      assert.equal(proposal.status,'PENDING');
      await page.goto(`${base}/actions/${proposal.id}`);
      const approvalButton=page.locator('form[action="/actions/'+proposal.id+'/approve"] button[type="submit"]');
      await approvalButton.click();let saved;
      for(let i=0;i<100;i++){saved=(await database.query('SELECT status FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,proposal.id])).rows[0];if(saved?.status==='EXECUTED')break;await new Promise(r=>setTimeout(r,100));}
      assert.equal(saved.status,'EXECUTED',(await page.locator('body').innerText()).slice(0,1200));
      await approvalButton.waitFor({state:'hidden'});
    }
    await ledger.configure(database,ctx,{startDate:'2026-09-01',currency:'USD'});
    const journal=await ledger.post(database,ctx,{postingDate:'2026-09-23',sourceKey:'accounting-export-fixture',
      description:'Certification journal',sourceType:'manual_certification',createdByType:'USER',lines:[
        {accountKey:'CASH',debitMinor:100},{accountKey:'OPERATING_EXPENSE',creditMinor:100},
      ]});

    await page.goto(`${base}/settings/connections`);const popupPromise=browserContext.waitForEvent('page');
    await page.getByRole('link',{name:'Connect QuickBooks Fixture'}).click();const popup=await popupPromise;
    await popup.waitForURL(/fixture-books-consent/);await popup.getByRole('link',{name:'Authorize Fixture Books'}).click();
    await page.waitForURL(/\/settings\/connections\/con_/);const connectionUrl=page.url();
    const connectionId=connectionUrl.split('/').pop();
    assert.match(await page.locator('main').innerText(),/Accounting control/);
    await page.locator('input[name="authority"][value="SHADOW"]').check();
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save authority',exact:true}).click()]);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Run read-only shadow comparison'}).click()]);
    assert.match(await page.locator('main').innerText(),/4 accounting difference/);
    const sync=require('../../src/accounting/postgres-integration-sync');
    const cashAccount=(await database.query("SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND system_key='CASH'",[ctx.workspaceId])).rows[0].id;
    const expenseAccount=(await database.query("SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND system_key='OPERATING_EXPENSE'",[ctx.workspaceId])).rows[0].id;
    for(const [accountId,externalId] of [[cashAccount,'ext-cash'],[expenseAccount,'ext-expense']]){
      const form=page.locator('form[action$="/accounting/map-account"]');
      await form.locator('[name="accountId"]').selectOption(accountId);
      await form.locator('[name="externalId"]').selectOption(externalId);
      await Promise.all([page.waitForNavigation(),form.getByRole('button',{name:'Save exact mapping'}).click()]);
    }
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Run read-only shadow comparison'}).click()]);
    const shadowPolicy=await sync.policy(database,ctx.workspaceId,connectionId);
    assert.equal(shadowPolicy.requested_authority,'SHADOW');assert.equal(shadowPolicy.posting_direction,'READ_ONLY');
    assert.equal(shadowPolicy.stage,'READ_ONLY_VERIFIED');assert.equal(shadowPolicy.write_enabled_at,null);
    assert.equal(await page.getByRole('button',{name:'Enable verified posting'}).count(),0);
    await assert.rejects(()=>sync.enableWrites(database,ctx,connectionId),/request posting authority/);
    assert.equal(providerWrites,0);
    await askAndApprove('Request governed posting for Fixture Books','connection.accounting_authority',
      {recordReference:connectionId,authority:'POST'});
    assert.equal((await sync.policy(database,ctx.workspaceId,connectionId)).last_shadow_run_id,null,
      'Changing authority must not reuse the previous read-only match');
    await assert.rejects(()=>sync.enableWrites(database,ctx,connectionId),/matching shadow reconciliation/);
    await page.goto(connectionUrl);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Run read-only shadow comparison'}).click()]);
    assert.match(await page.locator('main').innerText(),/Shadow comparison matched exactly/);
    const cashId=(await database.query(`SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND system_key='CASH'`,
      [ctx.workspaceId])).rows[0].id;
    const expenseId=(await database.query(`SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND system_key='OPERATING_EXPENSE'`,
      [ctx.workspaceId])).rows[0].id;
    for(const [accountId,externalId] of [[cashId,'ext-cash'],[expenseId,'ext-expense']]){
      const account=(await database.query('SELECT code FROM accounting_accounts WHERE id=$1',[accountId])).rows[0];
      await askAndApprove(`Map StockChief account ${account.code} to ${externalId} on Fixture Books`,
        'connection.map_account',{recordReference:connectionId,accountCode:account.code,externalId});
    }
    await page.goto(connectionUrl);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Run read-only shadow comparison'}).click()]);
    assert.match(await page.locator('main').innerText(),/Shadow comparison matched exactly/);
    await askAndApprove('Enable verified accounting posting for Fixture Books',
      'connection.accounting_enable',{recordReference:connectionId});
    await page.goto(connectionUrl);
    assert.match(await page.locator('main').innerText(),/WRITE ENABLED/i);
    await askAndApprove('Queue the ready posted journals for Fixture Books',
      'connection.accounting_export',{recordReference:connectionId});
    await page.goto(connectionUrl);
    assert.equal(providerWrites,0);assert.match(await page.locator('main').innerText(),/PENDING/);
    const runtime=runtimeHandlers.create(providers,{accountingCredentials:{accessToken:'worker-only'}});
    const completed=await jobs.processOne(database,runtime,{owner:'accounting-export-worker',leaseMs:30000});
    assert.equal(completed.status,'COMPLETED');assert.equal(providerWrites,1);
    assert.equal(posted[0].entry.id,journal.entry.id);
    assert.deepEqual(posted[0].entry.lines.map((line)=>line.external_account_id),['ext-cash','ext-expense']);
    assert.equal(await jobs.processOne(database,runtime,{owner:'accounting-export-worker',leaseMs:30000}),null);
    assert.equal(providerWrites,1);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM commercial_usage_events
      WHERE workspace_id=$1 AND meter='connected_operations' AND detail->>'operation'='journal_export' AND status='COMMITTED'`,[ctx.workspaceId])).rows[0].count,'1');
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
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM commercial_cost_events
      WHERE workspace_id=$1 AND operation='journal_export'`,[ctx.workspaceId])).rows[0].count,'2');
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
    const mismatch=await ledger.post(database,ctx,{postingDate:'2026-09-23',sourceKey:'accounting-export-mismatch',description:'Mismatch certification journal',sourceType:'manual_certification',createdByType:'USER',lines:[{accountKey:'CASH',debitMinor:25},{accountKey:'OPERATING_EXPENSE',creditMinor:25}]});
    mode='verification_failed';await page.goto(connectionUrl);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Queue ready journals'}).click()]);
    const mismatchJob=await jobs.processOne(database,runtime,{owner:'accounting-export-worker',leaseMs:30000});assert.equal(mismatchJob.status,'DEAD');assert.equal(providerWrites,3);
    const mismatchEffect=(await database.query("SELECT status,provider_reference FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2",[ctx.workspaceId,mismatch.entry.id])).rows[0];
    assert.equal(mismatchEffect.status,'AMBIGUOUS','A local validation error after posting must not classify the remote write as rejected');assert.equal(mismatchEffect.provider_reference.externalId,'qb-journal-'+mismatch.entry.entry_number);
    assert.equal(await jobs.processOne(database,runtime,{owner:'accounting-export-worker',leaseMs:30000}),null);assert.equal(providerWrites,3,'Verification failure must not issue the journal a second time');
    const effectId=(await database.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2",[ctx.workspaceId,mismatch.entry.id])).rows[0].id;
    await assert.rejects(()=>require('../../src/accounting/postgres-integration-sync').verifyExistingExport(database,{workspaceId:ctx.workspaceId,actorId:'not-a-member'},effectId),/Only an owner/);
    const otherOwner=await require('../../src/domain/postgres-auth-service').createBusiness(database,{name:'Another owner',businessName:'Another accounting tenant',email:require('node:crypto').randomUUID()+'@example.test',password:'Other!'+require('node:crypto').randomUUID()});
    await assert.rejects(()=>require('../../src/accounting/postgres-integration-sync').verifyExistingExport(database,{workspaceId:otherOwner.workspaceId,actorId:otherOwner.userId},effectId),/not found/);
    await database.query("UPDATE workspace_connectors SET provider_account_id='another-company' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,connectionId]);
    await assert.rejects(()=>require('../../src/accounting/postgres-integration-sync').verifyExistingExport(database,ctx,effectId),/original accounting company/);
    await database.query("UPDATE workspace_connectors SET provider_account_id='realm-fixture' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,connectionId]);mode='success';
    await page.goto(base+'/settings/operations/provider-effects/'+effectId);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Verify existing accounting record'}).click()]);
    assert.match(await page.locator('main').innerText(),/SUCCEEDED/);assert.equal(providerWrites,3,'Recovery must only read the existing provider record');assert.equal(refreshes,1,'Expired authorization must refresh within the metered verification operation');
    const recovered=(await database.query('SELECT status,provider_reference FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,effectId])).rows[0];assert.equal(recovered.status,'SUCCEEDED');assert.equal(recovered.provider_reference.providerAccountId,'realm-fixture');assert.equal(recovered.provider_reference.journalSnapshot.id,mismatch.entry.id);
    assert.equal((await jobs.get(database,mismatchJob.id,ctx.workspaceId)).status,'COMPLETED','A verified recovery must clear the active dead letter without re-executing it');
    assert.equal((await database.query("SELECT count(*) AS n FROM stockchief_runtime.job_events WHERE job_id=$1 AND event_type='VERIFICATION_RECOVERED'",[mismatchJob.id])).rows[0].n,'1');
    const repeat=await require('../../src/accounting/postgres-integration-sync').verifyExistingExport(database,ctx,effectId);assert.equal(repeat.replayed,true);assert.equal(providerWrites,3);
    assert.deepEqual(errors,[]);
  });
