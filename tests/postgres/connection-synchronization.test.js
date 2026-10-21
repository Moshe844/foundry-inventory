'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('playwright');
test('scheduled provider checks, browser controls, backoff and tenant authority share one policy',{timeout:180000},async t=>{
  const cluster=await require('../helpers/postgres-cluster').startCluster();
  const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
  await require('../../src/db/migrate-postgres').migratePostgres(db);
  let discoveries=0,unavailable=false,includeCatalog=false;
  const adapter={metadata:()=>({type:'fixture_sync',name:'Fixture Sync',available:true,authMode:'oauth',provides:['products']}),
    discover:async()=>{discoveries++;if(unavailable)throw Object.assign(new Error('Private provider detail must not reach the page'),{status:429,retryAfterMs:180000});
      return includeCatalog?{products:[{externalId:'amber',code:'AMBER-NEW',displayName:'Amber pack',providerData:{itemName:'Amber pack',priceMoney:{amount:0,currency:'USD'},inventoryCounts:[{externalLocationId:'annex',quantity:7}]}},
        {externalId:'cobalt',code:'COBALT-NEW',displayName:'Cobalt pack',providerData:{itemName:'Cobalt pack',priceMoney:{amount:850,currency:'USD'},inventoryCountNote:'The provider has not supplied tracked stock.',inventoryCounts:[]}}],
        locations:[{externalId:'annex',displayName:'Supplier annex',providerData:{kind:'store'}}]}:{products:[],locations:[]};}};
  const registry={get:type=>type==='fixture_sync'?adapter:null,catalog:()=>[adapter.metadata()]};
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:crypto.randomUUID(),connectionProviders:registry});
  const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
  const browser=await chromium.launch(),page=await browser.newPage(),base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();await db.close();await cluster.stop();});
  const email=crypto.randomUUID()+'@example.test';
  await page.goto(base+'/register');await page.getByLabel('Business name').fill('Synchronization verification');
  await page.getByLabel('Your name').fill('Owner');await page.getByLabel('Work email').fill(email);
  await page.locator('[name=password]').fill('Test!'+crypto.randomUUID());
  if(await page.locator('[name=confirmPassword]').count())await page.locator('[name=confirmPassword]').fill(await page.locator('[name=password]').inputValue());
  await Promise.all([page.waitForURL(base+'/onboarding'),page.getByRole('button',{name:'Create account'}).click()]);
  const owner=(await db.query('SELECT u.workspace_id,u.id,u.account_id FROM users u JOIN accounts a ON a.id=u.account_id WHERE a.email=$1',[email])).rows[0];
  const ctx={workspaceId:owner.workspace_id,actorId:owner.id},id='con_'+crypto.randomUUID().replaceAll('-',''),at=new Date(Date.now()-120000).toISOString();
  await db.query("UPDATE account_subscriptions SET plan_id='growth',plan_version_id=NULL WHERE account_id=$1",[owner.account_id]);
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,
    expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
    VALUES($1,$2,$3,'Fixture Sync','fixture_sync','connected','[]','[]','{}',1,'CONNECTED',$4,$5,$5)`,[id,ctx.workspaceId,'fixture_sync:'+id,ctx.actorId,at]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,id,'provider',{accessToken:'fixture'}));
  await db.query('UPDATE workspace_connectors SET credential_ref=$3 WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,id,'connection_credentials:'+id]);
  const runtime=require('../../src/operations/postgres-runtime-handlers').create(registry),sweep=()=>db.transaction(c=>runtime['system.runtime-sweep']({payload:{now:Date.now()}},c));
  assert.equal((await sweep()).scheduledProviderChecks,1);
  assert.equal((await sweep()).scheduledProviderChecks,0,'a second sweep cannot queue a duplicate');
  const queued=(await db.query("SELECT * FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='provider.catalog-sync'",[ctx.workspaceId])).rows;
  assert.equal(queued.length,1);
  const job={id:queued[0].id,workspaceId:ctx.workspaceId,payload:{connectorId:id}};
  await runtime['provider.catalog-sync'](job,db);assert.equal(discoveries,1);
  await db.query("UPDATE stockchief_runtime.jobs SET status='COMPLETED',completed_at=$2 WHERE id=$1",[job.id,new Date().toISOString()]);
  assert.equal((await sweep()).scheduledProviderChecks,0,'fresh evidence is not polled again immediately');
  await page.goto(base+'/settings/connections/'+id);
  const panel=page.getByRole('region',{name:'Automatic synchronization'});
  await assert.equal(await panel.getByLabel('Check frequency').inputValue(),'1');
  assert.match(await panel.innerText(),/Last completed check[\s\S]*Next check/);
  await panel.getByLabel('Check frequency').selectOption('15');
  await Promise.all([page.waitForNavigation(),panel.getByRole('button',{name:'Save synchronization'}).click()]);
  assert.equal(Number((await db.query('SELECT expected_interval_minutes FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0].expected_interval_minutes),15);
  const audit=(await db.query("SELECT payload,status FROM domain_events WHERE workspace_id=$1 AND source_record_id=$2 AND event_type='connection.synchronization.updated'",[ctx.workspaceId,id])).rows;
  assert.equal(audit.length,1);assert.equal(audit[0].status,'PROCESSED');
  assert.equal(JSON.parse(audit[0].payload).before.minutes,1);assert.equal(JSON.parse(audit[0].payload).after.minutes,15);
  await page.getByRole('region',{name:'Automatic synchronization'}).getByLabel('Automatic updates').selectOption('off');
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save synchronization'}).click()]);
  const connectionService=require('../../src/connections/postgres-service');
  assert.equal((await connectionService.get(db,ctx.workspaceId,id)).publicStatus,'Sync off');
  assert.equal((await runtime['provider.catalog-sync']({...job,id:crypto.randomUUID()},db)).skipped,'connection_not_active');
  assert.equal(discoveries,1);
  await assert.rejects(require('../../src/connections/postgres-synchronization').configure(db,{...ctx,actorId:'unrelated'},id,{minutes:1},{providers:registry}),/Only the business owner/);
  await assert.rejects(require('../../src/connections/postgres-synchronization').configure(db,ctx,'unowned',{minutes:1},{providers:registry}),/Connection not found/);
  await connectionService.resume(db,ctx.workspaceId,id);
  assert.equal((await connectionService.get(db,ctx.workspaceId,id)).status,'connected');
  assert.equal((await connectionService.get(db,ctx.workspaceId,id)).config.syncDisabled,false);
  unavailable=true;
  await assert.rejects(runtime['provider.catalog-sync']({...job,id:crypto.randomUUID()},db),e=>e.retryAfterMs>=180000);
  const failed=await connectionService.get(db,ctx.workspaceId,id);
  assert(failed.config.syncRetryAt);assert(!failed.last_error.includes('Private'));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM connection_sync_runs WHERE workspace_id=$1 AND connector_id=$2 AND status='RUNNING'",[ctx.workspaceId,id])).rows[0].n,0,'failed reads cannot leave a running import');
  assert.equal((await runtime['provider.catalog-sync']({...job,id:crypto.randomUUID()},db)).skipped,'provider_backoff');
  assert.equal(discoveries,2,'retry-after prevents another provider call');
  await page.reload();assert.match(await page.getByRole('region',{name:'Automatic synchronization'}).innerText(),/Waiting for the provider/);
  unavailable=false;includeCatalog=true;
  await db.query("UPDATE workspace_connectors SET config=$3,last_error=NULL WHERE workspace_id=$1 AND id=$2",
    [ctx.workspaceId,id,JSON.stringify({autoImportCatalog:true,autoImportOpeningStock:true})]);
  const imported=await runtime['provider.catalog-sync']({...job,id:crypto.randomUUID()},db);
  assert.equal(imported.importNeedsReview,undefined);assert.equal(imported.imported.products,2);
  assert.equal(imported.imported.locations,1);assert.equal(imported.imported.openingUnits,7);
  const movements=(await db.query('SELECT count(*)::int AS n,COALESCE(sum(quantity_delta),0)::int AS units FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
  assert.deepEqual(movements,{n:1,units:7});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0,'no cost or liability is inferred');
  const replayed=await runtime['provider.catalog-sync']({...job,id:crypto.randomUUID()},db);
  assert.equal(replayed.imported.openingUnits,0);assert.equal(replayed.imported.products,0);
  assert.deepEqual((await db.query('SELECT count(*)::int AS n,COALESCE(sum(quantity_delta),0)::int AS units FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0],movements,'repeated provider snapshots cannot duplicate stock');
  await db.query("UPDATE workspace_connectors SET config='{}' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id]);
  await assert.rejects(require('../../src/connections/postgres-catalog-import').createLocation(db,ctx,id,
    {externalId:'annex',automatic:true}),/Automatic import authority changed/,'already prepared automatic work must recheck current owner authority');
});
