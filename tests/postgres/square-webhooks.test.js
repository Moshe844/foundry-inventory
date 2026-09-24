'use strict';

const crypto=require('node:crypto');
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
const {newId,nowIso}=require('../../src/lib/util');

function signature(secret,url,body){
  return crypto.createHmac('sha256',secret).update(`${url}${body}`).digest('base64');
}

test('real Chromium qualifies signed Square sale, replay, forgery rejection and refund review without false stock',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-square-webhooks'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-square-webhook-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Square Webhook Business');
    await page.getByLabel('Your name').fill('Square Owner');await page.getByLabel('Work email').fill('square-webhook@example.test');
    await page.getByLabel('Password').fill('square-webhook-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='square-webhook@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const location=await locations.createLocation(database,ctx,{name:'Square Store',kind:'store'});
    const item=await catalog.createItem(database,ctx,{name:'Square Hat',baseCode:'SQ-HAT',trackingMode:'quantity',unitLabel:'unit'});
    await inventory.receive(database,ctx,{skuId:item.skuIds[0],locationId:location.id,quantity:5,
      reference:'OPENING',idempotencyKey:'square-webhook-opening'});
    const connectorId=newId('con');const at=nowIso();const webhookSecret='square-webhook-signature-secret';
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,
       expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
      VALUES($1,$2,$3,'Square Store','square','connected','["WEBHOOKS"]','["completed POS sales","returns"]','{}',
        5,'CONNECTED',$4,'square-merchant-1','Square test merchant',$5,$5)`,
    [connectorId,ctx.workspaceId,`square:${connectorId}`,ctx.actorId,at]);
    await credentialStore.put(database,ctx.workspaceId,connectorId,'provider',{
      accessToken:'encrypted-square-token',environment:'sandbox',webhookSignatureKey:webhookSecret,
    });
    for(const [entityType,externalId,foundryRecordId] of [
      ['sku','square-variation-1',item.skuIds[0]],['location','square-location-1',location.id],
    ])await database.query(`INSERT INTO connection_mappings
      (id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,confidence,approved_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'approved',$7,$8,$8)`,
    [newId('cmap'),ctx.workspaceId,connectorId,entityType,externalId,foundryRecordId,ctx.actorId,at]);

    const endpoint=`${base}/api/v1/connections/square/webhooks/${connectorId}`;
    const saleBody=JSON.stringify({event_id:'square-delivery-sale-1',type:'payment.updated',created_at:at,data:{object:{
      payment:{id:'square-payment-1',status:'COMPLETED',order_id:'square-order-1',location_id:'square-location-1',
        created_at:at,amount_money:{amount:2000,currency:'USD'}},
      order:{id:'square-order-1',location_id:'square-location-1',line_items:[{catalog_object_id:'square-variation-1',
        quantity:'2',base_price_money:{amount:1000,currency:'USD'}}]},
    }}});
    const send=async(body,token=signature(webhookSecret,endpoint,body))=>fetch(endpoint,{method:'POST',headers:{
      'content-type':'application/json','x-square-hmacsha256-signature':token},body});
    const accepted=await send(saleBody);assert.equal(accepted.status,200);assert.equal((await accepted.json()).accepted,1);
    const balance=async()=>Number((await database.query(`SELECT on_hand FROM balances
      WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,[ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand);
    assert.equal(await balance(),3);
    const replay=await send(saleBody);assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,1);
    assert.equal(await balance(),3);
    const forged=await send(saleBody,'forged-signature');assert.equal(forged.status,401);assert.equal(await balance(),3);

    const refundBody=JSON.stringify({event_id:'square-delivery-refund-1',type:'refund.updated',created_at:at,data:{object:{
      refund:{id:'square-refund-1',status:'COMPLETED',payment_id:'square-payment-1',order_id:'square-order-1',
        created_at:at,updated_at:at,amount_money:{amount:1000,currency:'USD'},reason:'Customer returned one hat'},
    }}});
    const refund=await send(refundBody);assert.equal(refund.status,200);const refundResult=await refund.json();
    assert.equal(refundResult.accepted,1);assert.equal(refundResult.results[0].status,'IGNORED');
    assert.equal(refundResult.results[0].requiresReview,true);assert.equal(await balance(),3);
    const refundReplay=await send(refundBody);assert.equal(refundReplay.status,200);
    assert.equal((await refundReplay.json()).replayed,1);assert.equal(await balance(),3);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM connector_feed_events
      WHERE workspace_id=$1 AND connector_id=$2`,[ctx.workspaceId,connectorId])).rows[0].count,'2');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM movements
      WHERE workspace_id=$1 AND reference='Square order square-order-1'`,[ctx.workspaceId])).rows[0].count,'1');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM connection_issues
      WHERE workspace_id=$1 AND issue_type='RETURN_REVIEW_REQUIRED' AND status='OPEN'`,[ctx.workspaceId])).rows[0].count,'1');

    await page.goto(`${base}/needs-you`);
    const main=await page.locator('main').innerText();
    assert.match(main,/Square Store reported a refund that needs return confirmation/);
    assert.match(main,/StockChief has not increased stock/);
    assert.deepEqual(errors,[]);
  });
