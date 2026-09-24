'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const credentialStore=require('../../src/connections/postgres-credential-store');
const locations=require('../../src/domain/postgres-location-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const {AuthenticationError}=require('../../src/domain/errors');
const {newId,nowIso}=require('../../src/lib/util');

const adapter={
  verifyWebhook({headers,credentials}){if(headers['x-clover-auth']!==credentials.webhookAuthCode)
    throw new AuthenticationError('This webhook did not pass Clover auth-code verification.');},
  async normalizeWebhook({body,connection}){return (body.merchants?.[connection.provider_account_id]||[]).map((update)=>({
    eventId:`clover-sale:${update.id}`,type:'sale.completed',occurredAt:update.occurredAt,
    data:{externalSku:update.externalSku,externalLocationId:connection.provider_account_id,quantity:update.quantity,
      unitPriceMinor:update.unitPriceMinor,reference:`Clover order ${update.id}`},
  }));},
};
const providers={get(type){return type==='clover'?adapter:null;},catalog(){return [];}};

test('real Chromium qualifies Clover merchant fan-out, unknown isolation, signature and replay on PostgreSQL',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-clover-webhooks'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-clover-webhook-secret',connectionProviders:providers});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Clover Webhook Business');
    await page.getByLabel('Your name').fill('Clover Owner');await page.getByLabel('Work email').fill('clover-webhook@example.test');
    await page.getByLabel('Password').fill('clover-webhook-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='clover-webhook@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const location=await locations.createLocation(database,ctx,{name:'Clover Store',kind:'store'});
    const item=await catalog.createItem(database,ctx,{name:'Clover Socks',baseCode:'CLOVER-SOCKS',trackingMode:'quantity',unitLabel:'pair'});
    await inventory.receive(database,ctx,{skuId:item.skuIds[0],locationId:location.id,quantity:7,
      reference:'OPENING',idempotencyKey:'clover-webhook-opening'});
    const connectorId=newId('con');const at=nowIso();
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,
       expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
      VALUES($1,$2,$3,'Clover Store','clover','connected','["WEBHOOKS"]','["completed POS sales"]','{}',
        5,'CONNECTED',$4,'merchant-1','Clover test merchant',$5,$5)`,
    [connectorId,ctx.workspaceId,`clover:${connectorId}`,ctx.actorId,at]);
    await credentialStore.put(database,ctx.workspaceId,connectorId,'provider',{merchantId:'merchant-1',
      webhookAuthCode:'clover-auth-secret',accessToken:'encrypted-token'});
    for(const [entityType,externalId,foundryRecordId] of [
      ['sku','clover-item-1',item.skuIds[0]],['location','merchant-1',location.id],
    ])await database.query(`INSERT INTO connection_mappings
      (id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,confidence,approved_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'approved',$7,$8,$8)`,
    [newId('cmap'),ctx.workspaceId,connectorId,entityType,externalId,foundryRecordId,ctx.actorId,at]);
    const endpoint=`${base}/api/v1/connections/clover/webhooks`;
    const body=JSON.stringify({merchants:{'merchant-1':[{id:'order-1',externalSku:'clover-item-1',quantity:2,
      unitPriceMinor:900,occurredAt:at}],'unknown-merchant':[{id:'ignored'}]}});
    const send=(token)=>fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','x-clover-auth':token},body});
    const accepted=await send('clover-auth-secret');assert.equal(accepted.status,200);const result=await accepted.json();
    assert.equal(result.accepted,1);assert.equal(result.ignored,1);assert.equal(result.merchants,1);
    const balance=async()=>Number((await database.query(`SELECT on_hand FROM balances
      WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,[ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand);
    assert.equal(await balance(),5);
    const replay=await send('clover-auth-secret');assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,1);
    assert.equal(await balance(),5);assert.equal((await send('forged')).status,401);assert.equal(await balance(),5);
    await page.goto(`${base}/inventory/${item.itemId}`);
    assert.match(await page.locator('main').innerText(),/Clover order order-1/);assert.deepEqual(errors,[]);
  });
