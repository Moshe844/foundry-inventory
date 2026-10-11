'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const locations=require('../../src/domain/postgres-location-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const commerce=require('../../src/operations/postgres-commerce');
const credentials=require('../../src/connections/postgres-credential-store');
const jobs=require('../../src/operations/postgres-job-queue');
const effects=require('../../src/operations/postgres-provider-effects');
const runtime=require('../../src/operations/postgres-runtime-handlers');
const {newId,nowIso}=require('../../src/lib/util');

test('browser purchasing refuses unproven provider responses and revoked authority',
  {timeout:240000},async(t)=>{
    let sendCalls=0;
    // This is an adverse response, not a simulated successful delivery.
    const adapter={metadata(){return {type:'gmail',name:'Gmail',category:'email',authMode:'oauth',available:true};},
      async send(){sendCalls+=1;return {};}};
    const providers={get(type){return type==='gmail'?adapter:null;},catalog(){return [adapter.metadata()];}};
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'autonomous-provider-fault-certification'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'autonomous-provider-fault-certification',
      connectionProviders:providers});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    t.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const suffix=crypto.randomBytes(3).toString('hex').toUpperCase();
    const business=`Harbor Service Parts ${suffix}`;
    const page=await browser.newPage();page.setDefaultTimeout(20000);
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill(business);
    await page.getByLabel('Your name').fill('Harbor Owner');
    await page.getByLabel('Work email').fill(`harbor-${suffix.toLowerCase()}@example.test`);
    await page.locator('input[name="password"]').fill('isolated-certification-password');
    if(await page.locator('input[name="confirmPassword"]').count())
      await page.locator('input[name="confirmPassword"]').fill('isolated-certification-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),
      page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id AND u.role='owner' WHERE w.name=$1`,[business])).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const place=await locations.createLocation(database,ctx,{name:`Parts Bay ${suffix}`,kind:'warehouse'});
    const supplier=await commerce.createSupplier(database,ctx,
      {name:`Regional Components ${suffix}`,email:`orders-${suffix.toLowerCase()}@supplier.example.test`});
    const connectorId=newId('con');const at=nowIso();
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,
       expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
      VALUES($1,$2,$3,'Fault Test Mailbox','gmail',$4,'{}','connected',$5,$6,5,'CONNECTED',$7,'fault-mailbox',
        'fault@example.test',$8,$8)`,[connectorId,ctx.workspaceId,`gmail:${connectorId}`,
      JSON.stringify(['business mail']),JSON.stringify(['mail:read','mail:send']),
      `connection_credentials:${connectorId}`,ctx.actorId,at]);
    await database.transaction((client)=>credentials.put(client,ctx.workspaceId,connectorId,'provider',
      {accessToken:'fault-test-token'}));
    await database.query('UPDATE suppliers SET watched_connector_id=$3 WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,supplier.id,connectorId]);
    async function seedShortage(label){
      const product=await catalog.createItem(database,ctx,{name:`${label} ${suffix}`,
        baseCode:`${label.toUpperCase().replaceAll(' ','-')}-${suffix}`,trackingMode:'quantity'});
      await database.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,supplier_sku,
        purchase_unit,units_per_purchase_unit,last_unit_cost,lead_time_days,minimum_order_quantity,
        order_multiple,is_preferred,is_active,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'case',4,3.00,5,1,1,1,1,$6,$6)`,
      [newId('supi'),ctx.workspaceId,supplier.id,product.skuIds[0],`CASE-${suffix}`,at]);
      await database.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,
        target_stock,safety_stock,preferred_supplier_id,lead_time_days,source,created_at,updated_at)
        VALUES($1,$2,$3,$4,2,8,1,$5,5,'manual',$6,$6)`,
      [newId('rpol'),ctx.workspaceId,product.skuIds[0],place.id,supplier.id,at]);
      return product.skuIds[0];
    }
    const firstSku=await seedShortage('Rotor Bolt');
    await page.goto(`${base}/autopilot`);
    await Promise.all([page.waitForURL(/\/autopilot#jobs$/),page.locator('.job')
      .filter({hasText:'Email suppliers'}).getByRole('button',{name:'Let StockChief do this'}).click()]);
    await page.locator('input[name="purchaseEnabled"]').check();
    await page.locator('input[name="supplierIds"]').check();
    await page.locator('input[name="maximumValue"]').fill('100');
    await page.locator('input[name="weeklyValue"]').fill('500');
    await Promise.all([page.waitForURL(`${base}/autopilot`),
      page.getByRole('button',{name:'Confirm these limits'}).click()]);
    await Promise.all([page.waitForURL(`${base}/autopilot`),
      page.getByRole('button',{name:'Check the operation now'}).click()]);
    const firstWork=(await database.query(`SELECT * FROM work_items WHERE workspace_id=$1
      AND affected_entities LIKE $2 ORDER BY created_at DESC LIMIT 1`,
    [ctx.workspaceId,`%${firstSku}%`])).rows[0];
    assert.equal(firstWork.execution_status,'EXECUTING');
    await Promise.all([page.waitForURL(`${base}/autopilot`),
      page.getByRole('button',{name:'Check the operation now'}).click()]);
    const repeated=(await database.query(`SELECT COUNT(*)::int AS work_count FROM work_items
      WHERE workspace_id=$1 AND affected_entities LIKE $2`,
    [ctx.workspaceId,`%${firstSku}%`])).rows[0];
    assert.equal(repeated.work_count,1,'Repeating the browser check must not queue another supplier order.');
    await Promise.all([page.waitForURL(/\/autopilot#jobs$/),page.locator('.job')
      .filter({hasText:'Email suppliers'}).getByRole('button',{name:'Take this back'}).click()]);
    assert.match(await page.locator('main').innerText(),/That authority was removed immediately/i);
    await jobs.processOne(database,runtime.create(providers),{owner:'fault-mail-worker'});
    const firstEffect=(await database.query(`SELECT status,result FROM stockchief_runtime.provider_effects
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,JSON.parse(firstWork.outcome).effectId])).rows[0];
    const firstOrder=(await database.query(`SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,firstWork.purchase_order_id])).rows[0];
    t.diagnostic(`After revocation: provider calls=${sendCalls}, effect=${firstEffect.status}, `+
      `external id=${firstEffect.result?.externalMessageId||'none'}, order=${firstOrder.status}`);

    // With authority restored, an empty provider receipt must never be called
    // delivered: the provider might have accepted it, so the outcome is uncertain.
    const secondSku=await seedShortage('Caliper Spring');
    await Promise.all([page.waitForURL(/\/autopilot#jobs$/),page.locator('.job')
      .filter({hasText:'Email suppliers'}).getByRole('button',{name:'Let StockChief do this'}).click()]);
    await Promise.all([page.waitForURL(`${base}/autopilot`),
      page.getByRole('button',{name:'Check the operation now'}).click()]);
    const secondWork=(await database.query(`SELECT * FROM work_items WHERE workspace_id=$1
      AND affected_entities LIKE $2 ORDER BY created_at DESC LIMIT 1`,
    [ctx.workspaceId,`%${secondSku}%`])).rows[0];
    assert.equal(secondWork.execution_status,'EXECUTING');
    await jobs.processOne(database,runtime.create(providers),{owner:'unverified-receipt-worker'});
    const unverified=(await database.query(`SELECT status,result FROM stockchief_runtime.provider_effects
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,JSON.parse(secondWork.outcome).effectId])).rows[0];
    const unverifiedOrder=(await database.query(`SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,secondWork.purchase_order_id])).rows[0];
    t.diagnostic(`Empty provider receipt: effect=${unverified.status}, order=${unverifiedOrder.status}`);
    assert.equal(unverified.status,'AMBIGUOUS');
    assert.equal(unverifiedOrder.status,'APPROVED');

    // A third work item models a worker dying after claim but before it calls
    // the provider. Recovery must fence the old claim and avoid a duplicate send.
    const thirdSku=await seedShortage('Cable Washer');
    await Promise.all([page.waitForURL(`${base}/autopilot`),
      page.getByRole('button',{name:'Check the operation now'}).click()]);
    const thirdWork=(await database.query(`SELECT * FROM work_items WHERE workspace_id=$1
      AND affected_entities LIKE $2 ORDER BY created_at DESC LIMIT 1`,
    [ctx.workspaceId,`%${thirdSku}%`])).rows[0];
    assert.equal(thirdWork.execution_status,'EXECUTING');
    const thirdEffectId=JSON.parse(thirdWork.outcome).effectId;
    await effects.claim(database,ctx.workspaceId,thirdEffectId);
    await database.query(`UPDATE stockchief_runtime.provider_effects
      SET claimed_at=now()-interval '10 minutes' WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,thirdEffectId]);
    await database.transaction((client)=>runtime.runtimeSweep({payload:{now:Date.now()}},client));
    const afterCrash=(await database.query(`SELECT status FROM stockchief_runtime.provider_effects
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,thirdEffectId])).rows[0];
    const callsBeforeRetry=sendCalls;
    await jobs.processOne(database,runtime.create(providers),{owner:'crash-replay-worker'});
    t.diagnostic(`After stale claim: effect=${afterCrash.status}, provider calls after retry=${sendCalls-callsBeforeRetry}`);
    assert.equal(afterCrash.status,'AMBIGUOUS');
    assert.equal(sendCalls,callsBeforeRetry,'A stale provider claim must not dispatch twice.');

    assert.equal(sendCalls,1,'Only the deliberately unverified provider response may have reached the mailbox.');
    assert.notEqual(firstEffect.status,'SUCCEEDED',
      'A provider response without an acceptance ID cannot verify delivery.');
  });
