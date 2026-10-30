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
const commercial=require('../../src/commercial/service');
const entitlements=require('../../src/entitlements/postgres-service');
const {newId}=require('../../src/lib/util');

test('real Chromium completes upgrade, scheduled downgrade, cancellation and reactivation',{timeout:180000},async(context)=>{
  const cluster=await startCluster();const database=openPostgres(cluster.connectionString,{applicationName:'commercial-lifecycle-ui'});
  await migratePostgres(database);const business=await auth.createBusiness(database,{name:'Lifecycle Owner',
    businessName:'Lifecycle Business',email:'lifecycle@example.test',password:'Lifecycle-password!'});
  await database.query(`UPDATE commercial_plans SET packaging_status='APPROVED',
    stripe_monthly_price_id='price_'||id||'_monthly',stripe_annual_price_id='price_'||id||'_annual'
    WHERE id IN ('starter','growth','pro')`);
  const version=(await database.query(`SELECT id FROM commercial_plan_versions WHERE plan_id='starter' AND status='ACTIVE'`)).rows[0];
  const now=Math.floor(Date.now()/1000);let providerSubscription={id:'sub_lifecycle',customer:'cus_lifecycle',status:'active',
    current_period_start:now-864000,current_period_end:now+1728000,cancel_at_period_end:false,
    metadata:{stockchief_account_id:business.accountId,stockchief_plan_id:'growth'},
    items:{data:[{id:'si_lifecycle',price:{id:'price_starter_monthly',recurring:{interval:'month'}}}]}};
  await database.query(`INSERT INTO account_subscriptions
    (id,account_id,plan_id,plan_version_id,status,billing_interval,stripe_customer_id,stripe_subscription_id,
     current_period_start,current_period_end,source) VALUES($1,$2,'starter',$3,'ACTIVE','MONTHLY','cus_lifecycle','sub_lifecycle',
     to_timestamp($4),to_timestamp($5),'TEST')`,[newId('sub'),business.accountId,version.id,
    providerSubscription.current_period_start,providerSubscription.current_period_end]);
  const envKeys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_STAGING_SUBSCRIPTION_CHECKOUT','STOCKCHIEF_BILLING_STRIPE_SECRET_KEY'];const savedEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));context.after(()=>{for(const k of envKeys)if(savedEnv[k]===undefined)delete process.env[k];else process.env[k]=savedEnv[k];});Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'staging',STOCKCHIEF_STAGING_SUBSCRIPTION_CHECKOUT:'1',STOCKCHIEF_BILLING_STRIPE_SECRET_KEY:'sk_test_round15'});
  const changes=[];const billingProvider={
    retrieveSubscription:async()=>structuredClone(providerSubscription),
    previewSubscriptionChange:async(input)=>({id:'preview_lifecycle',subscription_proration_date:input.prorationDate,
      lines:{data:[{amount:25000,parent:{subscription_item_details:{proration:true}}}]}}),
    updateSubscription:async(input)=>{changes.push(input);providerSubscription={...providerSubscription,cancel_at_period_end:false,
      metadata:{stockchief_account_id:business.accountId,stockchief_plan_id:input.planId},items:{data:[{id:'si_lifecycle',
        price:{id:input.priceId,recurring:{interval:input.priceId.includes('annual')?'year':'month'}}}]}};
      return structuredClone(providerSubscription);},
    setCancellation:async(input)=>{providerSubscription={...providerSubscription,cancel_at_period_end:input.cancelAtPeriodEnd};
      return structuredClone(providerSubscription);},
    scheduleDowngrade:async(input)=>{changes.push(input);return {id:'sched_lifecycle'};},
    listInvoices:async()=>({data:[]}),createPortal:async()=>({url:'https://billing.example.test/portal'}),
  };
  const app=createPostgresApp({database,env:'test',sessionSecret:'commercial-lifecycle-secret',
    commercialOptions:{billingProvider,loadInvoices:false,publicOrigin:'request',testMode:false}});
  const annual=await commercial.subscriptionChangeQuote(database,business.accountId,{planId:'pro',interval:'annual'},{provider:billingProvider,testMode:false});assert.equal(annual.priceId,'price_pro_annual');assert.equal(annual.interval,'ANNUAL');
  const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
  const browser=await chromium.launch();context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
    await app.locals.sessionStore.close();await database.close();cluster.stop();});const base=`http://127.0.0.1:${server.address().port}`;
  const page=await browser.newPage({viewport:{width:1360,height:900}});await page.goto(`${base}/login`);
  await page.getByLabel('Email').fill('lifecycle@example.test');await page.locator('input[name="password"]').fill('Lifecycle-password!');if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('Lifecycle-password!');
  await Promise.all([page.waitForURL(`${base}/`),page.getByRole('button',{name:'Sign in'}).click()]);

  await page.goto(`${base}/settings/billing`);await page.getByRole('link',{name:'Growth',exact:true}).click();
  await Promise.all([page.waitForURL(`${base}/settings/billing`),page.getByRole('button',{name:'Confirm upgrade'}).click()]);
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).plan_id,'starter');
  await commercial.handleBillingEvent(database,{id:'evt_verified_growth',created:now-1,type:'customer.subscription.updated',data:{object:structuredClone(providerSubscription)}});
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).plan_id,'growth');
  await page.reload();await page.getByRole('link',{name:'Pro',exact:true}).click();
  assert.match(await page.locator('body').innerText(),/Growth → Pro[\s\S]*estimated proration is \$250\.00/i);
  await Promise.all([page.waitForURL(`${base}/settings/billing`),page.getByRole('button',{name:'Confirm upgrade'}).click()]);
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).plan_id,'growth');
  await commercial.handleBillingEvent(database,{id:'evt_verified_upgrade',created:now,type:'customer.subscription.updated',data:{object:structuredClone(providerSubscription)}});
  await page.reload();assert.match(await page.locator('body').innerText(),/Current plan[\s\S]*Pro/);assert.equal(changes[0].prorationBehavior,'always_invoice');
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).plan_id,'pro');assert.equal((await entitlements.capabilityState(database,{accountId:business.accountId,workspaceId:business.workspaceId},'api.public')).enabled,true);
  await commercial.handleBillingEvent(database,{id:'evt_old_growth_after_upgrade',created:now-2000,
    type:'customer.subscription.updated',data:{object:{...structuredClone(providerSubscription),
      metadata:{stockchief_account_id:business.accountId,stockchief_plan_id:'growth'},
      items:{data:[{id:'si_lifecycle',price:{id:'price_growth_monthly',recurring:{interval:'month'}}}]}}}});
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).plan_id,'pro');

  await page.getByRole('link',{name:'Starter',exact:true}).click();assert.match(await page.locator('body').innerText(),/Pro → Starter/);
  assert.match(await page.locator('body').innerText(),/Scheduled for/);await Promise.all([page.waitForURL(`${base}/settings/billing`),
    page.getByRole('button',{name:'Schedule downgrade'}).click()]);
  assert.match(await page.locator('body').innerText(),/Your plan changes to Starter on/);assert.equal(changes[2].priceId,'price_starter_monthly');
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).plan_id,'pro');
  await Promise.all([page.waitForURL(base+'/settings/billing'),page.getByRole('button',{name:'Cancel at renewal'}).last().click()]);
  assert.match(await page.locator('body').innerText(),/Your plan ends on/);assert.doesNotMatch(await page.locator('body').innerText(),/Your plan changes to Starter on/);
  assert.equal((await database.query("SELECT status FROM commercial_subscription_changes WHERE account_id=$1 AND to_plan_id='starter' ORDER BY created_at DESC LIMIT 1",[business.accountId])).rows[0].status,'CANCELLED');
  await page.getByRole('button',{name:'Keep my subscription'}).click();await page.waitForURL(base+'/settings/billing');
  await page.getByRole('link',{name:'Starter',exact:true}).click();await Promise.all([page.waitForURL(base+'/settings/billing'),page.getByRole('button',{name:'Schedule downgrade'}).click()]);
  assert.match(await page.locator('body').innerText(),/Your plan changes to Starter on/);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM commercial_subscription_changes WHERE account_id=$1 AND to_plan_id='starter' AND status='PENDING'",[business.accountId])).rows[0].n,1,'a fresh review can schedule the same plan again after cancellation');
  const effective=Math.floor(new Date((await database.query(`SELECT effective_at FROM commercial_subscription_changes
    WHERE account_id=$1 AND to_plan_id='starter' AND status='PENDING'`,[business.accountId])).rows[0].effective_at).getTime()/1000);
  providerSubscription={...providerSubscription,current_period_start:effective,current_period_end:effective+2592000,
    items:{data:[{id:'si_lifecycle',price:{id:'price_starter_monthly',recurring:{interval:'month'}}}]}};
  await commercial.handleBillingEvent(database,{id:'evt_starter_renewal',created:effective,type:'customer.subscription.updated',
    data:{object:structuredClone(providerSubscription)}});
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).plan_id,'starter');assert.equal((await entitlements.capabilityState(database,{accountId:business.accountId,workspaceId:business.workspaceId},'api.public')).enabled,false);
  assert.equal((await database.query(`SELECT status FROM commercial_subscription_changes WHERE account_id=$1
    AND to_plan_id='starter' ORDER BY created_at DESC LIMIT 1`,[business.accountId])).rows[0].status,'APPLIED');

  await page.reload();
  await Promise.all([page.waitForURL(`${base}/settings/billing`),page.getByRole('button',{name:'Cancel at renewal'}).last().click()]);
  assert.match(await page.locator('body').innerText(),/Cancellation is scheduled/);
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).cancel_at_period_end,true);assert.match(await page.locator('body').innerText(),/Your plan ends on/);
  await page.getByRole('button',{name:'Keep my subscription'}).click();await page.waitForURL(`${base}/settings/billing`);
  assert.doesNotMatch(await page.locator('body').innerText(),/Cancellation is scheduled/);
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).cancel_at_period_end,false);
  const annualChange=await commercial.requestSubscriptionChange(database,business.accountId,{planId:'starter',interval:'annual'},{provider:billingProvider});
  await commercial.handleBillingEvent(database,{id:'evt_same_plan_annual',created:effective+1,type:'customer.subscription.updated',data:{object:structuredClone(providerSubscription)}});
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).billing_interval,'ANNUAL');
  assert.equal((await database.query('SELECT status FROM commercial_subscription_changes WHERE id=$1',[annualChange.changeId])).rows[0].status,'APPLIED');
  const monthlyQuote=await commercial.subscriptionChangeQuote(database,business.accountId,{planId:'starter',interval:'monthly'},{provider:billingProvider});assert.equal(monthlyQuote.downgrade,true);assert.equal(new Date(monthlyQuote.effectiveAt).getTime(),providerSubscription.current_period_end*1000);
  process.env.STOCKCHIEF_RUNTIME_ENV='production';const paused=await page.goto(base+'/billing/change?plan=pro&interval=monthly');assert.equal(paused.status(),409);assert.match(await page.locator('main').innerText(),/Plan changes are paused/);assert.doesNotMatch(await page.locator('main').innerText(),/Something went wrong|Commercial Readiness/);
  process.env.STOCKCHIEF_RUNTIME_ENV='staging';process.env.STOCKCHIEF_BILLING_STRIPE_SECRET_KEY='sk_live_refuse_round15';await assert.rejects(()=>commercial.subscriptionChangeQuote(database,business.accountId,{planId:'pro',interval:'monthly'},{provider:billingProvider}),/Plan changes are paused/);
});
