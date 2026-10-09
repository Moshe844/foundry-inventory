'use strict';
process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const auth=require('../../src/domain/postgres-auth-service');
const entitlements=require('../../src/entitlements/postgres-service');
const control=require('../../src/commercial/control-service');
const commercial=require('../../src/commercial/service');
const catalog=require('../../src/commercial/catalog');
const {newId}=require('../../src/lib/util');

test('commercial control system is versioned, atomic, idempotent and margin-aware',{timeout:120000},async(context)=>{
  const cluster=await startCluster();const database=openPostgres(cluster.connectionString,{applicationName:'commercial-control'});
  await migratePostgres(database);context.after(async()=>{await database.close();cluster.stop();});
  const business=await auth.createBusiness(database,{name:'Control Owner',businessName:'Control Business',
    email:'control@example.test',password:'commercial-control-password',now:'2026-10-01T00:00:00Z'});
  const version=(await database.query(`SELECT * FROM commercial_plan_versions WHERE plan_id='growth' AND status='ACTIVE'`)).rows[0];
  assert.ok(version);assert.ok(version.entitlements.length>0);assert.ok(version.meters.length>0);
  assert.deepEqual(version.meters.filter((entry)=>!entry.meter),[],JSON.stringify(version.meters));
  for(const entry of version.meters)assert.ok(catalog.meter(entry.meter),entry.meter);
  await database.query(`INSERT INTO account_subscriptions
    (id,account_id,plan_id,plan_version_id,status,billing_interval,current_period_start,current_period_end,source)
    VALUES($1,$2,'growth',$3,'ACTIVE','MONTHLY','2026-10-01','2026-11-01','TEST')`,
  [newId('sub'),business.accountId,version.id]);
  const scope={accountId:business.accountId,workspaceId:business.workspaceId};

  await context.test('plan snapshots are authoritative and grandfathered',async()=>{
    assert.equal((await entitlements.capabilityState(database,scope,'communications.email_ingestion')).enabled,true);
    await database.query(`UPDATE commercial_plan_entitlements SET enabled=0
      WHERE plan_id='growth' AND capability='communications.email_ingestion'`);
    assert.equal((await entitlements.capabilityState(database,scope,'communications.email_ingestion')).enabled,true);
  });

  await context.test('concurrent usage cannot cross a hard limit',async()=>{
    const current=await entitlements.subscriptionFor(database,business.accountId);
    const meters=current.plan_version_id?(await database.query('SELECT meters FROM commercial_plan_versions WHERE id=$1',
      [current.plan_version_id])).rows[0].meters:[];
    const policy=meters.find((entry)=>entry.meter==='ai_work_credits');policy.included_units=1;policy.hard_limit=1;
    await database.query('UPDATE commercial_plan_versions SET meters=$2::jsonb WHERE id=$1',[current.plan_version_id,JSON.stringify(meters)]);
    const results=await Promise.allSettled(['one','two'].map((key)=>entitlements.recordUsage(database,scope,{id:newId('usage'),
      meter:'intelligent_operations',units:1,idempotencyKey:key,occurredAt:'2026-10-02T00:00:00Z'})));
    assert.equal(results.filter((result)=>result.status==='fulfilled').length,1);
    assert.equal(results.filter((result)=>result.status==='rejected').length,1);
    assert.equal((await entitlements.meterState(database,scope,'intelligent_operations',{now:'2026-10-02'})).used,1);
  });

  await context.test('one logical operation is metered once',async()=>{
    const first=await entitlements.recordUsage(database,scope,{id:newId('usage'),meter:'business_communications',units:1,
      idempotencyKey:'email:stable',occurredAt:'2026-10-03T00:00:00Z'});
    const replay=await entitlements.recordUsage(database,scope,{id:newId('usage'),meter:'business_communications',units:1,
      idempotencyKey:'email:stable',occurredAt:'2026-10-03T00:00:00Z'});
    assert.equal(first.created,true);assert.equal(replay.created,false);
    assert.equal((await entitlements.meterState(database,scope,'business_communications',{now:'2026-10-03'})).used,1);
  });

  await context.test('cost assumptions are versioned and duplicate-safe',async()=>{
    const rate=await control.saveCostRate(database,{provider:'anthropic',operation:'ask_operation',unit:'operation',
      costPerUnitMinor:2.5,currency:'USD',effectiveFrom:'2026-10-01',source:'Contract test'});
    assert.equal(Number(rate.cost_per_unit_minor),2.5);
    const first=await control.recordCost(database,scope,{provider:'anthropic',operation:'ask_operation',unit:'operation',
      quantity:2,idempotencyKey:'ask:stable',occurredAt:'2026-10-04'});
    const replay=await control.recordCost(database,scope,{provider:'anthropic',operation:'ask_operation',unit:'operation',
      quantity:2,idempotencyKey:'ask:stable',occurredAt:'2026-10-04'});
    assert.equal(first.created,true);assert.equal(Number(first.event.amount_minor),5);assert.equal(replay.created,false);
    const economics=await control.economics(database,scope,{now:'2026-10-05'});
    // A measured model event does not establish hosting/database/provider costs.
    assert.equal(economics.estimatedCostMinor,null);assert.equal(economics.costCoverage,'MISSING');
    assert.equal(rate.pricing_basis,'UNVERIFIED');
    assert.equal(economics.estimatedCostEventCount,1);
    assert.equal(economics.conservativeEstimatedCostSubtotalMinor,5);
    assert.equal(economics.measuredCostSubtotalMinor,0);
  });

  await context.test('usage warnings are emitted once at durable thresholds',async()=>{
    const current=await entitlements.subscriptionFor(database,business.accountId);
    const meters=(await database.query('SELECT meters FROM commercial_plan_versions WHERE id=$1',[current.plan_version_id])).rows[0].meters;
    const policy=meters.find((entry)=>entry.meter==='connected_operations');policy.included_units=21;policy.hard_limit=21;
    await database.query('UPDATE commercial_plan_versions SET meters=$2::jsonb WHERE id=$1',[current.plan_version_id,JSON.stringify(meters)]);
    for(const [key,units] of [['batch-80',16],['batch-95',3],['batch-100',1]])await entitlements.recordUsage(database,scope,
      {id:newId('usage'),meter:'business_communications',units,idempotencyKey:key,occurredAt:'2026-10-06'});
    const warnings=(await database.query(`SELECT threshold FROM commercial_usage_notifications WHERE account_id=$1
      AND meter='connected_operations' ORDER BY threshold`,[business.accountId])).rows.map((row)=>Number(row.threshold));
    assert.deepEqual(warnings,[80,95,100]);
    assert.equal(Number((await database.query(`SELECT COUNT(*) AS count FROM stockchief_runtime.jobs
      WHERE kind='system.email-send' AND idempotency_key LIKE 'billing-usage-warning:%:connected_operations:%'`)).rows[0].count),3);
  });

  await context.test('disabled capabilities cannot be enabled by an override',async()=>{
    await database.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,capability,enabled,reason)
      VALUES($1,$2,'adaptive_optimization',1,'Must remain disabled')`,[newId('override'),business.accountId]);
    assert.equal((await entitlements.capabilityState(database,scope,'adaptive_optimization')).enabled,false);
  });

  await context.test('older Stripe subscription events cannot roll back a newer plan',async()=>{
    await database.query("UPDATE commercial_plans SET stripe_monthly_price_id='price_growth_ordered' WHERE id='growth'");
    await database.query("UPDATE commercial_plans SET stripe_monthly_price_id='price_starter_ordered' WHERE id='starter'");
    const event=(id,created,price)=>({id,created,type:'customer.subscription.updated',data:{object:{id:'sub_ordered',
      customer:'cus_ordered',status:'active',current_period_start:1790812800,current_period_end:1793491200,
      metadata:{stockchief_account_id:business.accountId},items:{data:[{price:{id:price,recurring:{interval:'month'}}}]}}}});
    await commercial.handleBillingEvent(database,event('evt_newer_growth',200,'price_growth_ordered'));
    await commercial.handleBillingEvent(database,event('evt_older_starter',100,'price_starter_ordered'));
    const subscription=await entitlements.subscriptionFor(database,business.accountId);
    assert.equal(subscription.plan_id,'growth');
    assert.equal(Number((await database.query(`SELECT COUNT(*) AS count FROM commercial_subscription_changes
      WHERE account_id=$1 AND status='APPLIED'`,[business.accountId])).rows[0].count),0);
  });
});

test('real Chromium shows metered Growth usage and activates Pro only from server-confirmed billing',{timeout:120000},async(context)=>{
  const cluster=await startCluster();const database=openPostgres(cluster.connectionString,{applicationName:'commercial-control-browser'});
  await migratePostgres(database);const business=await auth.createBusiness(database,{name:'Browser Owner',businessName:'Browser Business',
    email:'commercial-browser-control@example.test',password:'commercial-browser-password'});
  const growthVersion=(await database.query(`SELECT * FROM commercial_plan_versions WHERE plan_id='growth' AND status='ACTIVE'`)).rows[0];
  const growthMeters=growthVersion.meters;const intelligent=growthMeters.find((entry)=>entry.meter==='ai_work_credits');
  intelligent.included_units=10;intelligent.hard_limit=10;
  await database.query('UPDATE commercial_plan_versions SET meters=$2::jsonb WHERE id=$1',[growthVersion.id,JSON.stringify(growthMeters)]);
  await database.query(`INSERT INTO account_subscriptions
    (id,account_id,plan_id,plan_version_id,status,billing_interval,current_period_start,current_period_end,source)
    VALUES($1,$2,'growth',$3,'ACTIVE','MONTHLY',date_trunc('month',now()),date_trunc('month',now())+interval '1 month','TEST')`,
  [newId('sub'),business.accountId,growthVersion.id]);
  await database.query(`UPDATE commercial_plans SET packaging_status='APPROVED',stripe_monthly_price_id='price_pro_browser_monthly',
    stripe_annual_price_id='price_pro_browser_annual' WHERE id='pro'`);
  let checkoutInput=null;const billingProvider={
    createCheckout:async(input)=>{checkoutInput=input;const subscription={id:'sub_pro_browser',customer:'cus_pro_browser',status:'active',
      current_period_start:Math.floor(Date.now()/1000),current_period_end:Math.floor(Date.now()/1000)+2592000,
      metadata:{stockchief_account_id:input.accountId},items:{data:[{price:{id:'price_pro_browser_monthly',recurring:{interval:'month'}}}]}};
      await commercial.handleBillingEvent(database,{id:'evt_browser_verified',type:'customer.subscription.created',data:{object:subscription}});
      return {id:'cs_pro_browser',url:input.successUrl.replace('{CHECKOUT_SESSION_ID}','cs_pro_browser')};},
    retrieveCheckout:async()=>({id:'cs_pro_browser',status:'complete',payment_status:'paid',
      metadata:{stockchief_account_id:checkoutInput.accountId,stockchief_plan_id:'pro'},subscription:{id:'sub_pro_browser',
        customer:'cus_pro_browser',status:'active',current_period_start:Math.floor(Date.now()/1000),
        current_period_end:Math.floor(Date.now()/1000)+2592000,metadata:{stockchief_account_id:checkoutInput.accountId},
        items:{data:[{price:{id:'price_pro_browser_monthly',recurring:{interval:'month'}}}]}}}),
    listInvoices:async()=>({data:[]}),createPortal:async()=>({url:'https://billing.example.test/portal'}),
  };
  const provider={name:'anthropic',model:'fixture-model',async complete(){return {data:{intent:'lookup',view:'inventory',action:null,
    search:null,sku:null,location:null,fromLocation:null,toLocation:null,quantity:null,countedQuantity:null,reason:null,reference:null},
    usage:{provider:'anthropic',providerVersion:'2023-06-01',model:'fixture-model',inputTokens:120,outputTokens:40,latencyMs:4}};}};
  for(const operation of ['model_input','cache_write_1h','model_output'])await control.saveCostRate(database,
    {provider:'anthropic',model:'fixture-model',providerVersion:'2023-06-01',operation,unit:'token',
      costPerUnitMinor:.0001,pricingBasis:'VERIFIED_CONTRACT',confidence:'HIGH',source:'Synthetic browser-test fixture'});
  const app=createPostgresApp({database,env:'test',sessionSecret:'commercial-control-browser-secret',aiProvider:require('../helpers/postgres-model-fixture').fixture(provider),
    commercialOptions:{billingProvider,loadInvoices:false,publicOrigin:'request',testMode:true}});
  const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
  const browser=await chromium.launch();context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
    await app.locals.sessionStore.close();await database.close();cluster.stop();});const base=`http://127.0.0.1:${server.address().port}`;
  const page=await browser.newPage({viewport:{width:1280,height:900}});await page.goto(`${base}/login`);
  await page.getByLabel('Email').fill('commercial-browser-control@example.test');
  await page.locator('input[name="password"]').fill('commercial-browser-password');if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('commercial-browser-password');
  await Promise.all([page.waitForURL(`${base}/`),page.getByRole('button',{name:'Sign in'}).click()]);
  await page.goto(`${base}/billing`);assert.match(await page.locator('body').innerText(),/Growth/);
  assert.match(await page.locator('body').innerText(),/0 of 10 included/);
  await page.goto(`${base}/ask`);await page.getByLabel('Ask StockChief').fill('How many items are in my inventory?');
  await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
  await page.goto(`${base}/billing`);assert.match(await page.locator('body').innerText(),/1 of 10 included/);
  await page.goto(`${base}/pricing`);assert.equal(await page.getByRole('link',{name:'Choose Pro'}).count(),0);
  await page.goto(`${base}/billing`);const token=await page.locator('input[name="_csrf"]').first().inputValue();
  const checkout=await page.request.post(`${base}/billing/checkout`,{form:{_csrf:token,planId:'pro',interval:'monthly'}});
  assert.equal(new URL(checkout.url()).pathname,'/onboarding');
  await page.goto(`${base}/billing`);assert.match(await page.locator('body').innerText(),/Current plan[\s\S]*Pro/);
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).plan_id,'pro');
  assert.equal(Number((await database.query(`SELECT COUNT(*) AS count FROM commercial_subscription_changes
    WHERE account_id=$1 AND from_plan_id='growth' AND to_plan_id='pro' AND status='APPLIED'`,[business.accountId])).rows[0].count),1);
  assert.equal((await entitlements.capabilityState(database,{accountId:business.accountId,workspaceId:business.workspaceId},
    'authority.advanced')).enabled,true);
});
