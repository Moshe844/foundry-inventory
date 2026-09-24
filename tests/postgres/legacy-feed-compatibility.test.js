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
const inventory=require('../../src/domain/postgres-inventory-engine');
const commerce=require('../../src/operations/postgres-commerce');
const connections=require('../../src/connections/postgres-service');
const {newId,nowIso}=require('../../src/lib/util');

test('migrated event-feed clients retain native PostgreSQL inventory semantics and visible connection health',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-legacy-feed'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-legacy-feed-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Legacy Feed Business');
    await page.getByLabel('Your name').fill('Feed Owner');await page.getByLabel('Work email').fill('legacy-feed@example.test');
    await page.getByLabel('Password').fill('legacy-feed-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='legacy-feed@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const main=await locations.createLocation(database,ctx,{name:'Main warehouse',kind:'warehouse'});
    const branch=await locations.createLocation(database,ctx,{name:'Branch store',kind:'store'});
    const item=await catalog.createItem(database,ctx,{name:'Legacy Filter',baseCode:'LF-100',trackingMode:'quantity',unitLabel:'unit'});
    const skuId=item.skuIds[0];
    await inventory.receive(database,ctx,{skuId,locationId:main.id,quantity:30,reference:'OPENING',idempotencyKey:'legacy-opening'});
    const supplier=await commerce.createSupplier(database,ctx,{name:'Legacy Supply',email:'legacy-supply@example.test'});
    const at=nowIso();
    await database.query(`INSERT INTO supplier_items
      (id,workspace_id,supplier_id,sku_id,supplier_sku,purchase_unit,units_per_purchase_unit,is_preferred,is_active,created_at,updated_at)
      VALUES($1,$2,$3,$4,'LEGACY-FILTER','unit',1,1,1,$5,$5)`,
    [newId('si'),ctx.workspaceId,supplier.id,skuId,at]);
    const feed=await connections.createFeed(database,ctx,{displayName:'Migrated operating event feed',expectedIntervalMinutes:60});
    await database.query(`UPDATE workspace_connectors SET connector_key='foundry_event_feed'
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,feed.connection.id]);
    const headers={authorization:`Bearer ${feed.token}`,'content-type':'application/json'};

    const unauthorized=await fetch(`${base}/api/v1/feed/events`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({eventId:'unauthorized',type:'sale',skuCode:'LF-100',quantity:1})});
    assert.equal(unauthorized.status,401);

    const batch={events:[
      {eventId:'legacy-sale',type:'sale',supplierCode:'LEGACY-FILTER',supplierName:'Legacy Supply',
        locationName:'Main warehouse',quantity:3,occurredAt:'2026-09-20T12:00:00.000Z'},
      {eventId:'legacy-damage',type:'damage',skuCode:'LF-100',locationName:'Main warehouse',quantity:2},
      {eventId:'legacy-count',type:'count',skuCode:'LF-100',locationName:'Main warehouse',countedQty:20},
      {eventId:'legacy-transfer',type:'transfer',skuCode:'LF-100',fromLocationName:'Main warehouse',
        toLocationName:'Branch store',quantity:7},
    ]};
    const accepted=await fetch(`${base}/api/v1/feed/events`,{method:'POST',headers,body:JSON.stringify(batch)});
    assert.equal(accepted.status,200);const acceptedBody=await accepted.json();
    assert.deepEqual({accepted:acceptedBody.accepted,replayed:acceptedBody.replayed,rejected:acceptedBody.rejected},
      {accepted:4,replayed:0,rejected:0});
    assert.deepEqual(acceptedBody.results.map((entry)=>entry.type),['issue','issue','adjust','transfer']);
    const balances=async()=>Object.fromEntries((await database.query(`SELECT location_id,on_hand FROM balances
      WHERE workspace_id=$1 AND sku_id=$2`,[ctx.workspaceId,skuId])).rows.map((row)=>[row.location_id,Number(row.on_hand)]));
    assert.deepEqual(await balances(),{[main.id]:13,[branch.id]:7});
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM movements WHERE workspace_id=$1
      AND reference LIKE 'feed:legacy-%'`,[ctx.workspaceId])).rows[0].count,'5');
    assert.equal((await database.query(`SELECT reason_code FROM movements WHERE workspace_id=$1
      AND reference='feed:legacy-damage'`,[ctx.workspaceId])).rows[0].reason_code,'damaged');

    const replay=await fetch(`${base}/api/v1/feed/events`,{method:'POST',headers,
      body:JSON.stringify(batch.events[3])});
    assert.equal(replay.status,200);const replayBody=await replay.json();
    assert.deepEqual({accepted:replayBody.accepted,replayed:replayBody.replayed,rejected:replayBody.rejected},
      {accepted:0,replayed:1,rejected:0});
    assert.deepEqual(await balances(),{[main.id]:13,[branch.id]:7});

    const rejected=await fetch(`${base}/api/v1/feed/events`,{method:'POST',headers,
      body:JSON.stringify({eventId:'legacy-unknown',type:'sale',skuCode:'NOT-HERE',locationName:'Main warehouse',quantity:2})});
    assert.equal(rejected.status,207);const rejectedBody=await rejected.json();assert.equal(rejectedBody.rejected,1);
    assert.match(rejectedBody.results[0].error,/did not match a product/i);
    assert.equal((await database.query(`SELECT status FROM connector_feed_events WHERE workspace_id=$1
      AND connector_id=$2 AND external_event_id='legacy-unknown'`,[ctx.workspaceId,feed.connection.id])).rows[0].status,'REJECTED');
    assert.deepEqual(await balances(),{[main.id]:13,[branch.id]:7});
    await page.goto(`${base}/settings/connections/${feed.connection.id}`);
    assert.match(await page.locator('main').innerText(),/Needs attention/);
    assert.match(await page.locator('main').innerText(),/did not match a product/i);

    const recovered=await fetch(`${base}/api/v1/feed/events`,{method:'POST',headers,
      body:JSON.stringify({eventId:'legacy-return',type:'customer_return',skuCode:'LF-100',
        locationName:'Branch store',quantity:1})});
    assert.equal(recovered.status,200);assert.equal((await recovered.json()).accepted,1);
    assert.deepEqual(await balances(),{[main.id]:13,[branch.id]:8});
    await page.reload();const mainText=await page.locator('main').innerText();
    assert.match(mainText,/Connected/);assert.doesNotMatch(mainText,/did not match a product/i);
    assert.doesNotMatch(mainText,/Last activity\s+Not yet/i);
    assert.deepEqual(errors,[]);
  });
