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
const connections=require('../../src/connections/postgres-service');

test('PostgreSQL connector events authenticate, commit atomically, replay once and surface unknown mappings in the UI',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-connector-events'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-event-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Connector Event Business');
    await page.getByLabel('Your name').fill('Connector Owner');await page.getByLabel('Work email').fill('connector-event@example.test');
    await page.getByLabel('Password').fill('connector-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='connector-event@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const location=await locations.createLocation(database,ctx,{name:'Connector Store',kind:'store'});
    const item=await catalog.createItem(database,ctx,{name:'Connector Hat',baseCode:'HAT',trackingMode:'quantity',unitLabel:'unit'});
    await inventory.receive(database,ctx,{skuId:item.skuIds[0],locationId:location.id,quantity:5,
      reference:'OPENING',idempotencyKey:'connector-opening'});
    const feed=await connections.createFeed(database,ctx,{displayName:'Commerce event feed',expectedIntervalMinutes:60});
    const headers={authorization:`Bearer ${feed.token}`,'content-type':'application/json'};
    const event={eventId:'provider-sale-1',type:'sale.completed',version:'1',occurredAt:'2026-09-23T12:00:00.000Z',
      data:{externalSku:'provider-hat',skuCode:'HAT',externalLocationId:'provider-store',locationName:'Connector Store',quantity:2}};
    const accepted=await fetch(`${base}/api/v1/events`,{method:'POST',headers,body:JSON.stringify(event)});
    assert.equal(accepted.status,200);assert.equal((await accepted.json()).accepted,1);
    assert.equal(Number((await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
      [ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),3);
    const replay=await fetch(`${base}/api/v1/events`,{method:'POST',headers,body:JSON.stringify(event)});
    assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,1);
    assert.equal(Number((await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
      [ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),3);
    const conflict=await fetch(`${base}/api/v1/events`,{method:'POST',headers,body:JSON.stringify({...event,data:{...event.data,quantity:1}})});
    assert.equal(conflict.status,409);
    const unknown=await fetch(`${base}/api/v1/events`,{method:'POST',headers,body:JSON.stringify({eventId:'provider-sale-2',
      type:'sale.completed',data:{externalSku:'missing-hat',skuCode:'NO-SUCH-SKU',locationName:'Connector Store',quantity:1}})});
    assert.equal(unknown.status,207);const unknownBody=await unknown.json();assert.equal(unknownBody.needsMapping,1);
    assert.equal(Number((await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
      [ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),3);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM connector_feed_events
      WHERE workspace_id=$1 AND connector_id=$2`,[ctx.workspaceId,feed.connection.id])).rows[0].count,'2');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM movements WHERE workspace_id=$1 AND reference='external:provider-sale-1'`,
      [ctx.workspaceId])).rows[0].count,'1');
    await page.goto(`${base}/`);assert.equal(await page.locator('a[href="/needs-you"] .nav-count').innerText(),'1');
    await page.locator('.rm-rail__nav a[href="/needs-you"]').click();
    assert.match(await page.locator('main').innerText(),/Unknown sku from Commerce event feed/);
    assert.match(await page.locator('main').innerText(),/Choose the matching StockChief record once/);
    await page.goto(`${base}/settings/connections/${feed.connection.id}`);
    assert.match(await page.locator('main').innerText(),/Commerce event feed/);assert.match(await page.locator('main').innerText(),/Needs attention/);
    assert.deepEqual(errors,[]);
  });
