'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const locations=require('../../src/domain/postgres-location-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const credentials=require('../../src/connections/postgres-credential-store');
const ingestion=require('../../src/connections/postgres-event-ingestion');
const jobs=require('../../src/operations/postgres-job-queue');
const runtimeHandlers=require('../../src/operations/postgres-runtime-handlers');
const {newId,nowIso}=require('../../src/lib/util');

test('PostgreSQL provider discovery exact-maps safe records, queues signed changes and renders only ambiguous work',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-provider-sync'});
    await migratePostgres(database);
    let discoveries=0;
    const adapter={
      metadata(){return {type:'fixture_catalog',name:'Fixture Commerce',mark:'FC',category:'selling',authMode:'oauth',
        available:true,description:'Fixture provider discovery.',provides:['products and locations']};},
      async discover({credentials:providerCredentials}){
        discoveries+=1;assert.equal(providerCredentials.accessToken,'provider-secret');
        return {products:[
          {entityType:'sku',externalId:'external-safe',code:'SAFE-1',displayName:'Safe product',
            providerData:{itemName:'Safe product',variationName:null}},
          {entityType:'sku',externalId:'external-ambiguous',code:'NO-MATCH',displayName:'Provider-only product',
            providerData:{itemName:'Provider-only product',variationName:null}},
        ],locations:[{entityType:'location',externalId:'external-store',displayName:'Provider Store',providerData:{active:true}}]};
      },
    };
    const providers={get(type){return type==='fixture_catalog'?adapter:null;},catalog(){return [adapter.metadata()];}};
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-provider-sync-secret',connectionProviders:providers});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();const browserContext=await browser.newContext();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browserContext.newPage({viewport:{width:1440,height:900}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Provider Sync Business');
    await page.getByLabel('Your name').fill('Provider Owner');await page.getByLabel('Work email').fill('provider-sync@example.test');
    await page.getByLabel('Password').fill('provider-sync-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT workspace.id AS workspace_id,user_record.id AS actor_id
      FROM workspaces workspace JOIN users user_record ON user_record.workspace_id=workspace.id
      JOIN accounts account ON account.id=user_record.account_id WHERE account.email='provider-sync@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const location=await locations.createLocation(database,ctx,{name:'Provider Store',kind:'store'});
    const item=await catalog.createItem(database,ctx,{name:'Safe product',baseCode:'SAFE-1',trackingMode:'quantity',unitLabel:'unit'});
    const connectorId=newId('con');const at=nowIso();
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,
       expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
      VALUES($1,$2,$3,'Fixture Commerce','fixture_catalog',$4,'{}','connected',$5,$6,60,'CONNECTED',$7,
        'fixture-account','Fixture Store',$8,$8)`,[connectorId,ctx.workspaceId,`fixture_catalog:${connectorId}`,
      JSON.stringify(['products and locations']),JSON.stringify(['catalog:read']),
      `connection_credentials:${connectorId}`,ctx.actorId,at]);
    await database.transaction((client)=>credentials.put(client,ctx.workspaceId,connectorId,'provider',
      {accessToken:'provider-secret'}));
    await jobs.enqueue(database,{workspaceId:ctx.workspaceId,kind:'provider.catalog-sync',
      idempotencyKey:`provider-catalog-sync:${connectorId}:test`,payload:{connectorId},priority:25,maxAttempts:3});
    const runtime=runtimeHandlers.create(providers);
    const completed=await jobs.processOne(database,runtime,{owner:'provider-sync-worker',leaseMs:60000});
    assert.equal(completed.status,'COMPLETED');assert.equal(completed.result.autoMapped,2);
    assert.equal(completed.result.needsMapping,1);assert.equal(discoveries,1);
    const mappings=(await database.query(`SELECT entity_type,external_id,foundry_record_id FROM connection_mappings
      WHERE workspace_id=$1 AND connector_id=$2 ORDER BY entity_type,external_id`,[ctx.workspaceId,connectorId])).rows;
    assert.deepEqual(mappings,[
      {entity_type:'location',external_id:'external-store',foundry_record_id:location.id},
      {entity_type:'sku',external_id:'external-safe',foundry_record_id:item.skuIds[0]},
    ]);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM connection_external_records
      WHERE workspace_id=$1 AND connector_id=$2`,[ctx.workspaceId,connectorId])).rows[0].count,'3');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM connection_issues WHERE workspace_id=$1
      AND connector_id=$2 AND status='OPEN'`,[ctx.workspaceId,connectorId])).rows[0].count,'1');
    const auth={workspaceId:ctx.workspaceId,connectorId,actorId:ctx.actorId,displayName:'Fixture Commerce',
      providerType:'fixture_catalog'};
    const change={eventId:'fixture-product-change-1',type:'product.changed',occurredAt:nowIso(),
      data:{externalProductId:'external-safe'}};
    const scheduled=await ingestion.ingest(database,auth,change);
    assert.equal(scheduled.refreshScheduled,true);
    const replay=await ingestion.ingest(database,auth,change);
    assert.equal(replay.replayed,true);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM stockchief_runtime.jobs
      WHERE workspace_id=$1 AND kind='provider.catalog-sync'`,[ctx.workspaceId])).rows[0].count,'2');
    const refreshed=await jobs.processOne(database,runtime,{owner:'provider-refresh-worker',leaseMs:60000});
    assert.equal(refreshed.status,'COMPLETED');assert.equal(discoveries,2);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM connection_sync_runs
      WHERE workspace_id=$1 AND connector_id=$2 AND status='COMPLETED'`,[ctx.workspaceId,connectorId])).rows[0].count,'2');
    await page.goto(`${base}/settings/connections/${connectorId}`);
    const detail=await page.locator('main').innerText();
    assert.match(detail,/Products mapped\s+1/);assert.match(detail,/Locations mapped\s+1/);
    assert.match(detail,/Need your match\s+1/);assert.match(detail,/Refresh now/);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Refresh now'}).click()]);
    assert.match(await page.locator('main').innerText(),/Catalogue refresh queued/);
    await page.goto(`${base}/needs-you`);
    assert.match(await page.locator('main').innerText(),/Provider-only product needs a StockChief match/);
    assert.match(await page.locator('main').innerText(),/Choose the matching StockChief record once/);
    assert.deepEqual(errors,[]);
  });
