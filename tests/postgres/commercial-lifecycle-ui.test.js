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
  const version=(await database.query(`SELECT id FROM commercial_plan_versions WHERE plan_id='growth' AND status='ACTIVE'`)).rows[0];
  const now=Math.floor(Date.now()/1000);let providerSubscription={id:'sub_lifecycle',customer:'cus_lifecycle',status:'active',
    current_period_start:now-864000,current_period_end:now+1728000,cancel_at_period_end:false,
    metadata:{stockchief_account_id:business.accountId,stockchief_plan_id:'growth'},
    items:{data:[{id:'si_lifecycle',price:{id:'price_growth_monthly',recurring:{interval:'month'}}}]}};
  await database.query(`INSERT INTO account_subscriptions
    (id,account_id,plan_id,plan_version_id,status,billing_interval,stripe_customer_id,stripe_subscription_id,
     current_period_start,current_period_end,source) VALUES($1,$2,'growth',$3,'ACTIVE','MONTHLY','cus_lifecycle','sub_lifecycle',
     to_timestamp($4),to_timestamp($5),'TEST')`,[newId('sub'),business.accountId,version.id,
    providerSubscription.current_period_start,providerSubscription.current_period_end]);
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
    commercialOptions:{billingProvider,loadInvoices:false,publicOrigin:'request',testMode:true}});
  await assert.rejects(()=>commercial.beginCheckout(database,{id:business.accountId,email:'lifecycle@example.test'},
    {planId:'pro',interval:'annual',origin:'https://stockchief.example.test'},
    {provider:billingProvider,testMode:true}),/Annual billing is not available/);
  await assert.rejects(()=>commercial.subscriptionChangeQuote(database,business.accountId,
    {planId:'pro',interval:'annual'},{provider:billingProvider,testMode:true}),/Annual billing is not available/);
  const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
  const browser=await chromium.launch();context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
    await app.locals.sessionStore.close();await database.close();cluster.stop();});const base=`http://127.0.0.1:${server.address().port}`;
  const page=await browser.newPage({viewport:{width:1360,height:900}});await page.goto(`${base}/login`);
  await page.getByLabel('Email').fill('lifecycle@example.test');await page.locator('input[name="password"]').fill('Lifecycle-password!');if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('Lifecycle-password!');
  await Promise.all([page.waitForURL(`${base}/`),page.getByRole('button',{name:'Sign in'}).click()]);

  await page.goto(`${base}/billing`);await page.getByRole('link',{name:'Pro',exact:true}).click();
  assert.match(await page.locator('body').innerText(),/Growth → Pro[\s\S]*estimated proration is \$250\.00/i);
  await Promise.all([page.waitForURL(`${base}/billing`),page.getByRole('button',{name:'Confirm upgrade'}).click()]);
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).plan_id,'growth');
  await commercial.handleBillingEvent(database,{id:'evt_verified_upgrade',created:now,type:'customer.subscription.updated',data:{object:structuredClone(providerSubscription)}});
  await page.reload();assert.match(await page.locator('body').innerText(),/Current plan[\s\S]*Pro/);assert.equal(changes[0].prorationBehavior,'always_invoice');
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).plan_id,'pro');
  await commercial.handleBillingEvent(database,{id:'evt_old_growth_after_upgrade',created:now-2000,
    type:'customer.subscription.updated',data:{object:{...structuredClone(providerSubscription),
      metadata:{stockchief_account_id:business.accountId,stockchief_plan_id:'growth'},
      items:{data:[{id:'si_lifecycle',price:{id:'price_growth_monthly',recurring:{interval:'month'}}}]}}}});
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).plan_id,'pro');

  await page.getByRole('link',{name:'Starter',exact:true}).click();assert.match(await page.locator('body').innerText(),/Pro → Starter/);
  assert.match(await page.locator('body').innerText(),/Scheduled for/);await Promise.all([page.waitForURL(`${base}/billing`),
    page.getByRole('button',{name:'Schedule downgrade'}).click()]);
  assert.match(await page.locator('body').innerText(),/Starter scheduled for/);assert.equal(changes[1].priceId,'price_starter_monthly');
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).plan_id,'pro');
  const effective=Math.floor(new Date((await database.query(`SELECT effective_at FROM commercial_subscription_changes
    WHERE account_id=$1 AND to_plan_id='starter' AND status='PENDING'`,[business.accountId])).rows[0].effective_at).getTime()/1000);
  providerSubscription={...providerSubscription,current_period_start:effective,current_period_end:effective+2592000,
    items:{data:[{id:'si_lifecycle',price:{id:'price_starter_monthly',recurring:{interval:'month'}}}]}};
  await commercial.handleBillingEvent(database,{id:'evt_starter_renewal',created:effective,type:'customer.subscription.updated',
    data:{object:structuredClone(providerSubscription)}});
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).plan_id,'starter');
  assert.equal((await database.query(`SELECT status FROM commercial_subscription_changes WHERE account_id=$1
    AND to_plan_id='starter' ORDER BY created_at DESC LIMIT 1`,[business.accountId])).rows[0].status,'APPLIED');

  await page.reload();
  await Promise.all([page.waitForURL(`${base}/billing`),page.getByRole('button',{name:'Cancel at renewal'}).last().click()]);
  assert.match(await page.locator('body').innerText(),/Cancellation is scheduled/);
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).cancel_at_period_end,true);
  await page.getByRole('button',{name:'Keep my subscription'}).click();await page.waitForURL(`${base}/billing`);
  assert.doesNotMatch(await page.locator('body').innerText(),/Cancellation is scheduled/);
  assert.equal((await entitlements.subscriptionFor(database,business.accountId)).cancel_at_period_end,false);
});
