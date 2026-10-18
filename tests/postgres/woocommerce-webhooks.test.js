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
const costing=require('../../src/accounting/postgres-costing');
const {newId,nowIso}=require('../../src/lib/util');

const sign=(secret,body)=>crypto.createHmac('sha256',secret).update(body).digest('base64');

test('real Chromium qualifies signed WooCommerce create, snapshot fulfillment and cancellation on PostgreSQL',
  {timeout:180000},async(context)=>{
    const eventDay=new Date().toISOString().slice(0,10);
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-woocommerce-webhooks'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-woocommerce-webhook-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Woo Webhook Business');
    await page.getByLabel('Your name').fill('Woo Owner');await page.getByLabel('Work email').fill('woo-webhook@example.test');
    await page.locator('input[name="password"]').fill('woo-webhook-password');if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('woo-webhook-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='woo-webhook@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const location=await locations.createLocation(database,ctx,{name:'Woo Warehouse',kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:'Woo Mug',baseCode:'WOO-MUG',trackingMode:'quantity',unitLabel:'unit'});
    const received=await inventory.receive(database,ctx,{skuId:item.skuIds[0],locationId:location.id,quantity:8,
      reference:'OPENING',idempotencyKey:'woo-webhook-opening'});
    await database.transaction((client)=>costing.receiveInTransaction(client,ctx,{movementId:received.movementId,
      unitCostMinor:400,sourceType:'opening_inventory',sourceRecordId:received.movementId}));
    const connectorId=newId('con');const at=nowIso();const webhookSecret='woocommerce-webhook-secret';
    const storeUrl='https://woo.example.test';
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,
       expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
      VALUES($1,$2,$3,'Woo Store','woocommerce','connected','["WEBHOOKS"]','["customer orders","fulfillment"]',$4,
        5,'CONNECTED',$5,$6,'Woo test store',$7,$7)`,
    [connectorId,ctx.workspaceId,`woocommerce:${connectorId}`,JSON.stringify({storeUrl}),ctx.actorId,storeUrl,at]);
    await credentialStore.put(database,ctx.workspaceId,connectorId,'provider',{storeUrl,webhookSecret,
      consumerKey:'encrypted-key',consumerSecret:'encrypted-secret'});
    for(const [entityType,externalId,foundryRecordId] of [
      ['sku','501',item.skuIds[0]],['location',storeUrl,location.id],
    ])await database.query(`INSERT INTO connection_mappings
      (id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,confidence,approved_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'approved',$7,$8,$8)`,
    [newId('cmap'),ctx.workspaceId,connectorId,entityType,externalId,foundryRecordId,ctx.actorId,at]);
    const endpoint=`${base}/api/v1/connections/woocommerce/webhooks/${connectorId}`;
    const order=(id,status,quantity=2)=>({id,number:`WEB-${id}`,status,currency:'USD',customer_id:77,
      date_created_gmt:`${eventDay}T12:00:00.000Z`,date_modified_gmt:`${eventDay}T12:00:00.000Z`,
      billing:{first_name:'Wendy',last_name:'Buyer',email:`wendy-${id}@example.test`},
      shipping:{address_1:'10 Main Street',city:'Monroe',state:'NY',postcode:'10950',country:'US'},
      line_items:[{product_id:501,variation_id:0,sku:'WOO-MUG',quantity,price:'10.00'}]});
    const send=async(body,topic,delivery,token=sign(webhookSecret,body))=>fetch(endpoint,{method:'POST',headers:{
      'content-type':'application/json','x-wc-webhook-topic':topic,'x-wc-webhook-delivery-id':delivery,
      'x-wc-webhook-signature':token},body});

    const createdBody=JSON.stringify(order(9001,'processing'));
    const created=await send(createdBody,'order.created','woo-delivery-create-9001');
    assert.equal(created.status,202,await created.clone().text());assert.equal((await require('../helpers/provider-webhook-worker').result(database,created)).accepted,1);
    const mapped=(await database.query(`SELECT foundry_record_id FROM connection_mappings WHERE workspace_id=$1
      AND connector_id=$2 AND entity_type='sales_order' AND external_id='9001'`,[ctx.workspaceId,connectorId])).rows[0];
    assert.ok(mapped);
    let salesOrder=(await database.query('SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,mapped.foundry_record_id])).rows[0];
    assert.equal(salesOrder.status,'CONFIRMED');
    assert.equal((await database.query(`SELECT COALESCE(SUM(quantity),0) AS count FROM sales_order_allocations
      WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0].count,'2');
    const replay=await send(createdBody,'order.created','woo-delivery-create-9001');
    assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,1);
    const changedBody=JSON.stringify(order(9001,'processing',3));
    assert.equal((await send(changedBody,'order.created','woo-delivery-create-9001')).status,409);
    const retainedConflict=(await database.query('SELECT evidence FROM connection_event_conflicts WHERE workspace_id=$1 AND connector_id=$2',[ctx.workspaceId,connectorId])).rows;assert.equal(retainedConflict.length,1);assert.equal(retainedConflict[0].evidence.kind,'ENCRYPTED_WEBHOOK_CONFLICT');assert.doesNotMatch(JSON.stringify(retainedConflict[0].evidence),/wendy/);
    assert.equal((await send(changedBody,'order.created','woo-delivery-create-9001')).status,409);assert.equal(Number((await database.query('SELECT count(*) AS n FROM connection_event_conflicts WHERE workspace_id=$1 AND connector_id=$2',[ctx.workspaceId,connectorId])).rows[0].n),1);
    const forged=await send(createdBody,'order.created','woo-delivery-forged','forged');assert.equal(forged.status,401);

    const fulfilledBody=JSON.stringify({...order(9001,'completed'),date_modified_gmt:`${eventDay}T13:00:00.000Z`,
      date_completed_gmt:`${eventDay}T13:00:00.000Z`});
    const fulfilled=await send(fulfilledBody,'order.updated','woo-delivery-fulfilled-9001');
    assert.equal(fulfilled.status,202);assert.equal((await require('../helpers/provider-webhook-worker').result(database,fulfilled)).accepted,2);
    salesOrder=(await database.query('SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,mapped.foundry_record_id])).rows[0];
    assert.equal(salesOrder.status,'FULFILLED');
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),6);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM accounting_customer_invoices
      WHERE workspace_id=$1 AND sales_order_id=$2`,[ctx.workspaceId,salesOrder.id])).rows[0].count,'1');

    const secondBody=JSON.stringify(order(9002,'processing',1));
    const secondResponse=await send(secondBody,'order.created','woo-delivery-create-9002');assert.equal(secondResponse.status,202);await require('../helpers/provider-webhook-worker').result(database,secondResponse);
    const cancelledBody=JSON.stringify({...order(9002,'cancelled',1),date_modified_gmt:`${eventDay}T14:00:00.000Z`});
    const cancelled=await send(cancelledBody,'order.updated','woo-delivery-cancel-9002');
    assert.equal(cancelled.status,202);assert.equal((await require('../helpers/provider-webhook-worker').result(database,cancelled)).accepted,1);
    const cancelledOrder=(await database.query(`SELECT so.* FROM sales_orders so JOIN connection_mappings m
      ON m.foundry_record_id=so.id WHERE m.workspace_id=$1 AND m.connector_id=$2 AND m.entity_type='sales_order'
        AND m.external_id='9002'`,[ctx.workspaceId,connectorId])).rows[0];
    assert.equal(cancelledOrder.status,'CANCELLED');
    assert.equal((await database.query(`SELECT COALESCE(SUM(a.quantity),0) AS count FROM sales_order_allocations a
      JOIN sales_order_lines l ON l.id=a.sales_order_line_id WHERE l.workspace_id=$1 AND l.sales_order_id=$2`,
    [ctx.workspaceId,cancelledOrder.id])).rows[0].count,'0');

    await page.goto(`${base}/sales/orders/${salesOrder.id}`);
    const main=await page.locator('main').innerText();assert.match(main,/WEB-9001/);assert.match(main,/Fulfilled/i);

    // Retain the original signed body before a missing dependency. A fresh
    // worker process must resume it, without replaying successful effects.
    await locations.createLocation(database,ctx,{name:'Second isolated warehouse',kind:'warehouse'});
    await database.query("DELETE FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='location'",[ctx.workspaceId,connectorId]);
    const customersBefore=Number((await database.query('SELECT count(*) AS n FROM customers WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);
    const waitingOrder=order(9003,'processing',1);waitingOrder.billing.first_name='New customer awaiting mapping';
    const waitingBody=JSON.stringify({...waitingOrder,customer_id:78});
    const waiting=await send(waitingBody,'order.created','woo-waiting-9003');assert.equal(waiting.status,202);
    const waitingResult=await require('../helpers/provider-webhook-worker').result(database,waiting);assert.equal(waitingResult.processingStatus,'NEEDS_MAPPING',JSON.stringify({result:waitingResult,diagnostic:(await database.query('SELECT error_code,error_message FROM connection_webhook_receipts WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,waitingResult.receiptId])).rows[0]}));
    const receipt=(await database.query("SELECT id,status,ciphertext FROM connection_webhook_receipts WHERE workspace_id=$1 AND connector_id=$2 AND delivery_id='woo-waiting-9003'",[ctx.workspaceId,connectorId])).rows[0];
    assert.equal(receipt.status,'NEEDS_MAPPING');assert.doesNotMatch(receipt.ciphertext,/wendy|9003/);
    assert.equal(Number((await database.query('SELECT count(*) AS n FROM customers WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),customersBefore,'Mapping failure must roll back a customer created before the missing location was discovered');
    await page.goto(`${base}/settings/connections/${connectorId}`);assert.match(await page.locator('main').innerText(),/Needs a match/);
    const proofDir=require('node:path').resolve('../../output/integrations/webhook-recovery');require('node:fs').mkdirSync(proofDir,{recursive:true});await page.screenshot({path:require('node:path').join(proofDir,'simulated-signed-event-waiting.png'),fullPage:true});
    await assert.rejects(()=>require('../../src/connections/postgres-webhook-inbox').resume(database,{workspaceId:'foreign-workspace',actorId:ctx.actorId},connectorId,receipt.id),/Only an owner/);
    await require('../../src/connections/postgres-provider-sync').setMapping(database,ctx,{connectorId,entityType:'location',externalId:storeUrl,foundryRecordId:location.id});
    assert.equal((await database.query('SELECT status FROM connection_webhook_receipts WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,receipt.id])).rows[0].status,'RECEIVED','The exact resolved mapping should queue safe resumption automatically');
    const redelivery=await send(waitingBody,'order.created','woo-waiting-9003-redelivery');assert.equal(redelivery.status,202);const redeliveryAck=await redelivery.json();const outOfOrder=await require('../../src/connections/postgres-webhook-inbox').processReceipt(database,ctx.workspaceId,redeliveryAck.receiptId);assert.equal(outOfOrder.processingStatus,'COMPLETED','A new delivery must resume against the original held pricing receipt');
    const freshWorkerCode=`(async()=>{const db=require('./src/db/postgres').openPostgres(process.env.TEST_WEBHOOK_DB);try{const all=require('./src/operations/postgres-runtime-handlers').create(),handlers={'provider.webhook-process':all['provider.webhook-process']};for(let i=0;i<20;i++){const next=await require('./src/operations/postgres-job-queue').processOne(db,handlers,{owner:'fresh-provider-worker'});if(!next)break;}console.log('FRESH_WORKER_COMPLETE');}finally{await db.close();}})().catch(e=>{console.error(e.code||e.name);process.exitCode=1;});`;
    const freshWorker=require('node:child_process').spawnSync(process.execPath,['-e',freshWorkerCode],{cwd:process.cwd(),env:{...process.env,NODE_ENV:'test',TEST_WEBHOOK_DB:cluster.connectionString},windowsHide:true,encoding:'utf8',timeout:60000});
    assert.equal(freshWorker.status,0,freshWorker.stderr);assert.match(freshWorker.stdout,/FRESH_WORKER_COMPLETE/);
    assert.equal((await database.query('SELECT status FROM connection_webhook_receipts WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,receipt.id])).rows[0].status,'COMPLETED');
    assert.equal(Number((await database.query('SELECT count(*) AS n FROM customers WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),customersBefore+1);
    assert.equal(Number((await database.query("SELECT count(*) AS n FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='sales_order' AND external_id='9003'",[ctx.workspaceId,connectorId])).rows[0].n),1);
    assert.equal((await send(waitingBody,'order.created','woo-waiting-9003')).status,200);
    assert.equal(Number((await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),6);
    await page.reload();assert.doesNotMatch(await page.locator('main').innerText(),/Events still being resolved/);await page.screenshot({path:require('node:path').join(proofDir,'simulated-signed-event-recovered.png'),fullPage:true});
    require('node:fs').writeFileSync(require('node:path').join(proofDir,'result.json'),JSON.stringify({kind:'SIMULATED_SIGNED_PROVIDER_HTTP_REAL_POSTGRES_BROWSER_AND_FRESH_WORKER',liveProviderWebhooks:false,encryptedEvidence:true,missingMappingHeld:true,partialCustomerRolledBack:true,automaticMappingResumption:true,redeliveryUsesOriginalReceipt:true,freshWorkerCompleted:true,duplicateOrders:0,physicalUnits:6,foreignResumeRefused:true,paidModelCalls:0,providerWrites:0},null,2));
    const inbox=require('../../src/connections/postgres-webhook-inbox');
    const pausedResponse=await send(JSON.stringify(order(9004,'processing',1)),'order.created','woo-paused-9004');
    const pausedReceipt=(await pausedResponse.json()).receiptId;
    await database.query('UPDATE workspace_connectors SET paused_at=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,connectorId,nowIso()]);
    assert.equal((await inbox.processReceipt(database,ctx.workspaceId,pausedReceipt)).processingStatus,'PAUSED');
    assert.equal((await database.query('SELECT status FROM connection_webhook_receipts WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,pausedReceipt])).rows[0].status,'RETRY_PENDING');
    await assert.rejects(()=>inbox.resume(database,ctx,connectorId,pausedReceipt),/Reconnect or resume/);
    await database.query('UPDATE workspace_connectors SET paused_at=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,connectorId]);
    await inbox.resume(database,ctx,connectorId,pausedReceipt);
    await require('../helpers/provider-webhook-worker').drain(database);
    assert.equal((await database.query('SELECT status FROM connection_webhook_receipts WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,pausedReceipt])).rows[0].status,'COMPLETED');
    const interruptedResponse=await send(JSON.stringify(order(9005,'processing',1)),'order.created','woo-interrupted-9005');
    const interruptedReceipt=(await interruptedResponse.json()).receiptId;
    await database.query("UPDATE connection_webhook_receipts SET status='PROCESSING',claim_token='interrupted-fixture',lease_until=now()+interval '1 minute' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,interruptedReceipt]);
    assert.equal((await inbox.resume(database,ctx,connectorId,interruptedReceipt)).replayed,true,'An active claim cannot be stolen');
    await database.query("UPDATE connection_webhook_receipts SET lease_until=now()-interval '1 second' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,interruptedReceipt]);
    await inbox.resume(database,ctx,connectorId,interruptedReceipt);
    await require('../helpers/provider-webhook-worker').drain(database);
    assert.equal((await database.query('SELECT status FROM connection_webhook_receipts WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,interruptedReceipt])).rows[0].status,'COMPLETED');
    assert.equal(Number((await database.query("SELECT count(*) AS n FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='sales_order' AND external_id IN ('9004','9005')",[ctx.workspaceId,connectorId])).rows[0].n),2);
    assert.equal(Number((await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand),6,'Recovery must not invent fulfillment or duplicate stock effects');
    assert.deepEqual(errors,[]);
  });
