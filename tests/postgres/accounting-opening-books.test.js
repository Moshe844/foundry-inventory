'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres'),{migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app'),auth=require('../../src/domain/postgres-auth-service');
const sync=require('../../src/accounting/postgres-integration-sync'),ledger=require('../../src/accounting/postgres-ledger');
test('owner reviews PostgreSQL starting books in Chromium, changed balances stop and exact approval imports once without provider writes',
 {timeout:240000},async t=>{
  const cluster=await startCluster(),db=openPostgres(cluster.connectionString);await migratePostgres(db);
  const date=new Date().toISOString().slice(0,10);let changed=false,providerReads=0,providerWrites=0;
  const snapshot=()=>({asOf:date,currency:'USD',version:'read-'+providerReads,accounts:[
    {externalId:'bank',name:'Checking',accountType:'Bank',classification:'Asset',balanceMinor:12500+(changed?100:0)},
    {externalId:'payable',name:'Trade payable',accountType:'Accounts Payable',classification:'Liability',balanceMinor:-7500},
    {externalId:'capital',name:'Capital',accountType:'Equity',classification:'Equity',balanceMinor:-5000-(changed?100:0)},
    {externalId:'card',name:'Company card',accountType:'Credit Card',classification:'Liability',balanceMinor:0},
    {externalId:'cogs',name:'Cost of goods',accountType:'Cost of Goods Sold',classification:'Expense',balanceMinor:0},
  ]});
  const native=require('../../src/connections/providers/quickbooks'),oldRead=native.readAccountingSnapshot,oldFetch=global.fetch;
  global.fetch=async(url,options)=>{if(['127.0.0.1','localhost'].includes(new URL(url).hostname))return oldFetch(url,options);throw new Error('No live external calls permitted in this regression');};
  native.readAccountingSnapshot=async()=>{providerReads++;return snapshot();};
  const adapter={integrationClass:'accounting',metadata(){return{type:'quickbooks',name:'Books Fixture',mark:'QB',category:'accounting',authMode:'oauth',available:true,description:'Read-only test',provides:['accounting evidence']};},
    authorizationUrl({state,input}){return{url:new URL(input.redirectUri).origin+'/fixture-consent?callback='+encodeURIComponent(input.redirectUri)+'&state='+encodeURIComponent(state),metadata:{redirectUri:input.redirectUri}};},
    async exchangeAuthorization(){return{credentials:{accessToken:'fixture-only',refreshToken:'fixture-only',expiresAt:new Date(Date.now()+3600000).toISOString(),realmId:'fixture-realm'},accountId:'fixture-realm',accountName:'Fixture Books',capabilities:['accounting:read','accounting:post'],verifiedFact:{label:'Company',value:'Fixture Books',externalId:'fixture-realm'}};},
    async readAccountingSnapshot(){providerReads++;return snapshot();},async postJournalEntry(){providerWrites++;throw new Error('No outbound write permitted');}};
  const registry={get:type=>type==='quickbooks'?adapter:null,catalog:()=>[adapter.metadata()]};
  const app=createPostgresApp({database:db,env:'test',sessionSecret:'opening-books-local-fixture-secret',connectionProviders:registry});
  app.get('/fixture-consent',(req,res)=>res.send('<a href="'+req.query.callback+'?code=fixture-code&state='+encodeURIComponent(req.query.state)+'">Authorize fixture</a>'));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),browser=await chromium.launch({headless:true,args:['--disable-popup-blocking']}),bc=await browser.newContext(),page=await bc.newPage(),base='http://127.0.0.1:'+server.address().port,errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  t.after(async()=>{native.readAccountingSnapshot=oldRead;global.fetch=oldFetch;await browser.close();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();await db.close();cluster.stop();});
  await page.goto(base+'/register');await page.getByLabel('Business name').fill('Starting Books');await page.getByLabel('Your name').fill('Books Owner');await page.getByLabel('Work email').fill('opening-books@example.test');await page.locator('[name="password"]').fill('fixture-only-password');
  if(await page.locator('[name="confirmPassword"]').count())await page.locator('[name="confirmPassword"]').fill('fixture-only-password');
  await Promise.all([page.waitForURL(base+'/onboarding'),page.getByRole('button',{name:'Create account'}).click()]);
  const identity=(await db.query(`SELECT w.id AS workspace_id,u.id AS actor_id,a.id AS account_id FROM workspaces w JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='opening-books@example.test'`)).rows[0],ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
  await page.goto(base+'/settings/connections');const pendingPopup=bc.waitForEvent('page');await page.getByRole('link',{name:'Connect Books Fixture'}).click();const popup=await pendingPopup;await popup.waitForURL(/fixture-consent/);await popup.getByRole('link',{name:'Authorize fixture'}).click();await page.waitForURL(/\/settings\/connections\/con_/);
  const connectionUrl=page.url(),connectorId=connectionUrl.split('/').pop();assert.equal((await sync.policy(db,ctx.workspaceId,connectorId)).posting_direction,'READ_ONLY');
  await page.locator('input[name="authority"][value="SHADOW"]').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save authority',exact:true}).click()]);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Run read-only shadow comparison'}).click()]);
  const card=page.getByRole('region',{name:'Review starting balances'});assert.match(await card.innerText(),/\$125\.00/);assert.match(await card.innerText(),/does not send a journal/);
  const input={runId:await card.locator('[name="runId"]').inputValue(),scopeHash:await card.locator('[name="scopeHash"]').inputValue()},beforeAccounts=(await db.query('SELECT count(*) AS n FROM accounting_accounts WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
  changed=true;await assert.rejects(sync.importOpeningBooks(db,ctx,connectorId,input),/provider balances changed/);changed=false;
  assert.equal((await db.query('SELECT count(*) AS n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');assert.equal((await db.query('SELECT count(*) AS n FROM accounting_accounts WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,beforeAccounts);
  await assert.rejects(sync.importOpeningBooks(db,ctx,connectorId,{...input,scopeHash:'0'.repeat(64)}),/reviewed comparison/);
  const foreign=await auth.createWorkspace(db,identity.account_id,{name:'Other Books',dataMode:'synthetic'});await assert.rejects(sync.importOpeningBooks(db,{workspaceId:foreign.workspaceId,actorId:foreign.userId},connectorId,input),/not found|could not/i);
  await assert.rejects(sync.importOpeningBooks(db,{workspaceId:ctx.workspaceId,actorId:foreign.userId},connectorId,input),/Only an owner/);
  // Race an actual browser approval with the same authorized submission as
  // another tab. Exactly one opening journal may result.
  await Promise.all([Promise.all([page.waitForNavigation(),card.getByRole('button',{name:'Approve these starting balances'}).click()]),sync.importOpeningBooks(db,ctx,connectorId,input)]);
  assert.match(await page.locator('main').innerText(),/starting balances (?:are|were already) recorded/i);
  const replay=await Promise.all([sync.importOpeningBooks(db,ctx,connectorId,input),sync.importOpeningBooks(db,ctx,connectorId,input)]);assert(replay.every(row=>row.replayed));
  const journals=(await db.query('SELECT * FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows;assert.equal(journals.length,1);assert.equal(journals[0].source_record_type,'accounting_connection_opening');assert.equal((typeof journals[0].metadata==='string'?JSON.parse(journals[0].metadata):journals[0].metadata).openingScopeHash,input.scopeHash);
  const amounts=(await db.query('SELECT sum(debit_minor) AS debit,sum(credit_minor) AS credit,count(*) AS lines FROM accounting_journal_lines WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];assert.equal(amounts.debit,'12500');assert.equal(amounts.credit,'12500');assert.equal(amounts.lines,'3');
  assert.equal((await db.query('SELECT count(*) AS n FROM accounting_posting_account_mappings WHERE workspace_id=$1 AND connector_id=$2',[ctx.workspaceId,connectorId])).rows[0].n,'5');
  assert.equal((await db.query(`SELECT account_type FROM accounting_accounts WHERE workspace_id=$1 AND name='Company card'`,[ctx.workspaceId])).rows[0].account_type,'LIABILITY');assert.equal((await db.query(`SELECT account_type FROM accounting_accounts WHERE workspace_id=$1 AND name='Cost of goods'`,[ctx.workspaceId])).rows[0].account_type,'COGS');
  assert.equal((await sync.policy(db,ctx.workspaceId,connectorId)).posting_direction,'READ_ONLY');assert.equal((await sync.policy(db,ctx.workspaceId,connectorId)).write_enabled_at,null);assert.equal((await sync.pendingEntries(db,ctx.workspaceId,connectorId)).length,0);await assert.rejects(sync.enableWrites(db,ctx,connectorId),/request posting authority/);
  const matched=await sync.shadow(db,ctx,connectorId,adapter,{} ,{asOf:date});assert.equal(matched.status,'MATCHED');assert.equal(providerWrites,0);assert(providerReads>=3);
  // A fresh ordinary journal makes the opening path ineligible for all other
  // snapshots, and changing the approval cannot replay a different scope.
  await assert.rejects(sync.importOpeningBooks(db,ctx,connectorId,{...input,scopeHash:'1'.repeat(64)}),/different approval/);
  const posted=await ledger.post(db,{workspaceId:foreign.workspaceId,actorId:foreign.userId},{postingDate:date,sourceKey:'unrelated-entry',lines:[{accountKey:'CASH',debitMinor:100},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:100}]});assert(posted.entry.id);
  const otherCtx={workspaceId:foreign.workspaceId,actorId:foreign.userId},providerService=require('../../src/connections/postgres-provider-service');
  const begun=await providerService.beginAuthorization(db,otherCtx,{providerType:'quickbooks'},base,{providers:registry});
  const authorized=await providerService.completeOAuth(db,'quickbooks',{state:new URL(begun.redirectUrl).searchParams.get('state'),code:'fixture'},base,{providers:registry});
  await sync.chooseAuthority(db,otherCtx,authorized.id,'SHADOW');const occupiedShadow=await sync.shadow(db,otherCtx,authorized.id,adapter,{}, {asOf:date});
  const occupiedPreview=await sync.openingBooksPreview(db,foreign.workspaceId,authorized.id);assert.equal(occupiedPreview,null);
  await assert.rejects(sync.importOpeningBooks(db,otherCtx,authorized.id,{runId:occupiedShadow.runId,scopeHash:require('../../src/accounting/provider-opening-scope').scope('quickbooks',snapshot()).scopeHash}),/empty books/);
  assert.equal((await db.query('SELECT count(*) AS n FROM accounting_journal_entries WHERE workspace_id=$1',[foreign.workspaceId])).rows[0].n,'1');
  assert.equal((await db.query('SELECT count(*) AS n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'1');assert.deepEqual(errors,[]);
 });
