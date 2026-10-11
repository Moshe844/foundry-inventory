'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {chromium}=require('playwright');
const config=require('../../src/config');
const {createProviderUnobserved}=require('../../src/ai/provider');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const locations=require('../../src/domain/postgres-location-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const commerce=require('../../src/operations/postgres-commerce');
const credentials=require('../../src/connections/postgres-credential-store');
const jobs=require('../../src/operations/postgres-job-queue');
const runtime=require('../../src/operations/postgres-runtime-handlers');
const {newId,nowIso}=require('../../src/lib/util');

test('one unscripted browser goal prepares a complete supplier order mission',
  {skip:!config.ai.configured,timeout:360000},async(t)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'autonomous-purchasing-live-certification'});
    await migratePostgres(database);
    const provider=createProviderUnobserved(config.ai.provider,config.ai.tier('fast'));
    const mailbox={metadata(){return {type:'gmail',name:'Gmail',category:'email',authMode:'oauth',available:true};},
      async send(){throw new Error('Certification does not provide external delivery acceptance.');}};
    const providers={get(type){return type==='gmail'?mailbox:null;},catalog(){return [mailbox.metadata()];}};
    const app=createPostgresApp({database,env:'test',sessionSecret:'autonomous-purchasing-live-certification',
      aiProvider:provider,connectionProviders:providers});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    t.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const suffix=crypto.randomBytes(3).toString('hex').toUpperCase();
    const business=`Copperline Bicycle Service ${suffix}`;
    const product=`Disc Brake Pad ${suffix}`;const sku=`BRAKE-PAD-${suffix}`;
    const warehouse=`Repair Store ${suffix}`;const supplierName=`Trail Parts ${suffix}`;
    const page=await browser.newPage();page.setDefaultTimeout(90000);
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill(business);
    await page.getByLabel('Your name').fill('Copperline Owner');
    await page.getByLabel('Work email').fill(`copperline-${suffix.toLowerCase()}@example.test`);
    await page.locator('input[name="password"]').fill('isolated-certification-password');
    if(await page.locator('input[name="confirmPassword"]').count())
      await page.locator('input[name="confirmPassword"]').fill('isolated-certification-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),
      page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id AND u.role='owner' WHERE w.name=$1`,[business])).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    await locations.createLocation(database,ctx,{name:warehouse,kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:product,baseCode:sku,trackingMode:'quantity'});
    const supplier=await commerce.createSupplier(database,ctx,
      {name:supplierName,email:`orders-${suffix.toLowerCase()}@trail.example.test`});
    const connectorId=newId('con');const at=nowIso();
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,
       expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
      VALUES($1,$2,$3,'Certification Mailbox','gmail',$4,'{}','connected',$5,$6,5,'CONNECTED',$7,'cert-mailbox',
        'cert@example.test',$8,$8)`,[connectorId,ctx.workspaceId,`gmail:${connectorId}`,
      JSON.stringify(['business mail']),JSON.stringify(['mail:read','mail:send']),
      `connection_credentials:${connectorId}`,ctx.actorId,at]);
    await database.transaction((client)=>credentials.put(client,ctx.workspaceId,connectorId,'provider',
      {accessToken:'certification-only-token'}));
    await database.query('UPDATE suppliers SET watched_connector_id=$3 WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,supplier.id,connectorId]);
    await database.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,supplier_sku,
      purchase_unit,units_per_purchase_unit,last_unit_cost,lead_time_days,minimum_order_quantity,
      order_multiple,is_preferred,is_active,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'each',1,3.25,5,1,1,1,1,$6,$6)`,
    [newId('supi'),ctx.workspaceId,supplier.id,item.skuIds[0],`PAD-${suffix}`,at]);
    await page.goto(`${base}/ask`);
    await page.getByLabel('Ask StockChief').fill(`Order 8 ${product} (${sku}) from ${supplierName} `+
      `at $3.25 each for ${warehouse}. Approve the purchase order, email the supplier the order, `+
      'and wait for the mailbox provider to confirm that it accepted the message before marking the PO ordered.');
    await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
    const mission=(await database.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
    const browserReply=(await page.locator('main').innerText()).slice(-1500);
    t.diagnostic(`Purchasing browser reply: ${browserReply.replace(/\s+/g,' ').slice(0,700)}`);
    t.diagnostic(`Prepared capabilities: ${JSON.stringify(mission?.steps?.map((step)=>step.capability)||null)}`);
    assert.ok(mission,`Ask did not create a mission for the complete purchasing goal: ${browserReply}`);
    const names=mission.steps.map((step)=>step.capability);
    assert.ok(names.includes('purchase_order.create'));
    assert.ok(names.includes('purchase_order.approve'));
    assert.ok(names.includes('communication.send_email'),
      'The plan must include real supplier contact, not just an internal PO status.');
    const place=names.indexOf('purchase_order.place');const email=names.indexOf('communication.send_email');
    assert.ok(place<0||place>email,'The order cannot be marked placed before supplier delivery is verified.');
    await page.getByRole('link',{name:'Review prepared change'}).click();
    await Promise.all([page.waitForURL(/\/ask#latest$/),
      page.getByRole('button',{name:'Approve the whole mission'}).click()]);
    const after=(await database.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,mission.id])).rows[0];
    const orders=(await database.query(`SELECT status,po_number FROM purchase_orders
      WHERE workspace_id=$1`,[ctx.workspaceId])).rows;
    const messages=(await database.query(`SELECT status,recipient,subject,body FROM supplier_communications
      WHERE workspace_id=$1`,[ctx.workspaceId])).rows;
    t.diagnostic(`After one approval: mission=${after.status}, states=${JSON.stringify(after.steps.map((step)=>step.state))}, `+
      `orders=${JSON.stringify(orders)}, messages=${JSON.stringify(messages)}`);
    t.diagnostic(`Mission step reasons: ${JSON.stringify(after.steps.map((step)=>({capability:step.capability,
      reason:step.reason,args:step.args}))).slice(0,2500)}`);
    assert.equal(after.metrics.approvalInteractions,1);
    assert.equal(after.status,'WAITING_EVENT');
    assert.equal(orders.length,1);
    assert.equal(orders[0].status,'APPROVED');
    assert.equal(messages.length,1);
    assert.equal(messages[0].status,'QUEUED');
    assert.match(messages[0].body,new RegExp(`8 × ${sku}`));
    assert.doesNotMatch(messages[0].body,/attach(?:ed|ment)?/i);
    await jobs.processOne(database,runtime.create(providers),{owner:'purchasing-fault-provider'});
    await database.transaction((client)=>runtime.runtimeSweep({payload:{now:Date.now()}},client));
    await jobs.processOne(database,runtime.create(providers),{owner:'purchasing-fault-resume',now:Date.now()+1});
    const stopped=(await database.query(`SELECT status,verification_status,steps FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,mission.id])).rows[0];
    const unchanged=(await database.query(`SELECT status FROM purchase_orders WHERE workspace_id=$1`,
    [ctx.workspaceId])).rows[0];
    t.diagnostic(`After uncertain provider response: mission=${stopped.status}, order=${unchanged.status}`);
    assert.equal(stopped.status,'BLOCKED');
    assert.equal(stopped.verification_status,'FAILED');
    assert.equal(unchanged.status,'APPROVED');
  });
