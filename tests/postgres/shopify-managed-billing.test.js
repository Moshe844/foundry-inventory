'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('managed Shopify billing activates exact plans, preserves Stripe ownership and verifies refund evidence',{timeout:360000},async t=>{
 const env={...process.env};process.env.SHOPIFY_PARTNER_ID='5146412';process.env.SHOPIFY_PUBLIC_APP_ID='448446889985';process.env.SHOPIFY_PARTNER_ACCESS_TOKEN='fixture-partner-token';process.env.SHOPIFY_PUBLIC_CLIENT_ID='fixture-public-client';
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 const auth=require('../../src/domain/postgres-auth-service'),service=require('../../src/commercial/postgres-shopify-billing'),provider=require('../../src/commercial/shopify-billing'),ent=require('../../src/commercial/entitlements');
 try{
  await require('../../src/db/migrate-postgres').migratePostgres(db);
  let sequence=0;
  async function fixture(plan){const n=++sequence;let account=await auth.createPendingAccount(db,{name:'Shopify '+n,email:'shopify-billing-'+n+'@example.test',password:'ShopifyBillingFixture!42',businessName:'Shopify fixture '+n,planId:plan});await db.query('UPDATE accounts SET email_verified_at=now() WHERE id=$1',[account.id]);account=await auth.getAccount(db,account.id);
   const owner={appId:'gid://shopify/App/448446889985',shopId:'gid://shopify/Shop/'+n,shop:'billing-'+n+'.myshopify.com',appHandle:'stockchief',developmentStore:false};
   const now=Date.now(),remote={shop:{id:owner.shopId,myshopifyDomain:owner.shop},billingPeriod:'EVERY_30_DAYS',cancelAtEndOfCycle:false,trialEndsAt:null,currentBillingCycle:{startTime:new Date(now-60000).toISOString(),endTime:new Date(now+29*86400000).toISOString()},items:[{handle:plan,price:{__typename:'FlatRatePrice',active:true,currency:'USD',amount:(provider.PRICES[plan]/100).toFixed(2)}}]};
   const events=[{id:'created-'+n,eventType:'SUBSCRIPTION_CREATED',occurredAt:new Date(now-60000).toISOString(),subject:{id:owner.appId},shop:{id:owner.shopId,myshopifyDomain:owner.shop}},{id:'charge-'+n,eventType:'CHARGE_RECURRING',chargeId:'app-charge-'+n,planHandle:plan,amount:{amount:(provider.PRICES[plan]/100).toFixed(2),currencyCode:'USD'},occurredAt:new Date(now-60000).toISOString(),subject:{id:owner.appId},shop:{id:owner.shopId,myshopifyDomain:owner.shop}}];return {account,owner,remote,events};
  }
  for(const plan of ['starter','growth','pro'])await t.test(plan+' activates once, with the exact accepted limits and no Stripe identifiers',async()=>{
   const f=await fixture(plan);await service.reserve(db,f.account,f.owner);const created=await service.apply(db,f.account.id,f.owner,f.remote,f.events);assert(created.active);assert(created.workspaceId);
   const sub=await ent.subscriptionFor(db,f.account.id);assert.equal(sub.plan_id,plan);assert.equal(sub.source,'SHOPIFY');assert.equal(sub.stripe_subscription_id,null);assert.equal(sub.stripe_customer_id,null);assert(sub.plan_version_id);assert.equal(ent.operationalAccess(sub).canOperate,true);
   await service.apply(db,f.account.id,f.owner,f.remote,f.events);assert.equal((await db.query('SELECT count(*)::int n FROM workspaces WHERE owner_account_id=$1',[f.account.id])).rows[0].n,1);
   assert.equal((await ent.subscriptionFor(db,f.account.id)).plan_version_id,sub.plan_version_id);
   await assert.rejects(()=>require('../../src/commercial/service').beginCheckout(db,f.account,{planId:'pro',interval:'monthly'}),/managed through Shopify/);
   await assert.rejects(()=>service.reserve(db,{...f.account,id:'other-account'},f.owner));
   const q=await service.quote(db,f.account.id);assert(q.eligible);assert.equal(new Date(q.deadline)-new Date(q.subscription.first_subscription_at),14*86400000);
   assert.equal((await service.quote(db,f.account.id,{now:new Date(q.deadline).getTime()})).eligible,true);assert.equal((await service.quote(db,f.account.id,{now:new Date(q.deadline).getTime()+1})).eligible,false);
   assert.equal((await service.quote(db,f.account.id,{now:Date.now()+15*86400000})).eligible,false,'Renewal cannot reset the saved first-subscription deadline');
   const request=await service.requestRefund(db,f.account.id);assert.equal((await service.requestRefund(db,f.account.id)).id,request.id,'Repeat clicks retain one request');
   let active=true,cancels=0;const fake={active:async()=>active?provider.contract(f.remote,f.owner):null,cancel:async()=>{cancels++;active=false;return {cancelledAt:new Date().toISOString()};},history:async()=>f.events};
   const job={payload:{accountId:f.account.id,requestId:request.id}};
   assert.equal((await service.processGuarantee(db,job,{provider:fake})).status,'AWAITING_SHOPIFY');assert.equal(ent.operationalAccess(await ent.subscriptionFor(db,f.account.id)).canOperate,false);
   const refund={id:'refund-'+plan,eventType:'EARNING_REFUND',earningChargeId:f.events[1].chargeId,grossAmount:{amount:f.events[1].amount.amount,currencyCode:'USD'},occurredAt:new Date().toISOString(),subject:{id:f.owner.appId},shop:{id:f.owner.shopId,myshopifyDomain:f.owner.shop}};
   const partial={...refund,id:'partial-'+plan,grossAmount:{amount:'1.00',currencyCode:'USD'}};fake.history=async()=>[...f.events,partial];assert.equal((await service.processGuarantee(db,job,{provider:fake})).status,'PARTIAL');
   fake.history=async()=>[...f.events,{...refund,earningChargeId:'unrelated-charge'}];assert.equal((await service.processGuarantee(db,job,{provider:fake})).status,'AWAITING_SHOPIFY','A refund for another charge cannot satisfy this guarantee');
   fake.history=async()=>[...f.events,refund];assert.equal((await service.processGuarantee(db,job,{provider:fake})).status,'REFUNDED');assert.equal(cancels,1,'Provider cancellation is not duplicated on reconciliation');
   assert.equal((await db.query('SELECT status FROM support_requests WHERE request_key=$1',['shopify-guarantee:'+request.id])).rows[0].status,'RESOLVED');
  });
  await t.test('existing Stripe subscribers cannot reserve or replace billing, including cancelled Stripe records',async()=>{
   const f=await fixture('starter');await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,stripe_subscription_id,stripe_customer_id) VALUES('stripe-owned-fixture',$1,'starter','CANCELLED','sub_preserved','cus_preserved')",[f.account.id]);
   const before=(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.account.id])).rows;
   await assert.rejects(()=>service.reserve(db,f.account,f.owner),/billed through Stripe/);assert.deepEqual((await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.account.id])).rows,before);
  });
  await t.test('foreign provider evidence and unsigned or unknown plan values cannot activate an account',async()=>{
   const f=await fixture('growth');await service.reserve(db,f.account,f.owner);
   await db.query("UPDATE commercial_shopify_subscriptions SET reserved_until=now()-interval '2 days' WHERE account_id=$1",[f.account.id]);
   await assert.rejects(()=>require('../../src/commercial/service').beginCheckout(db,f.account,{planId:'starter',interval:'monthly'}),/managed through Shopify/,'A delayed Shopify return cannot open a second Stripe checkout after its browser reservation expires');
   await assert.rejects(()=>service.apply(db,f.account.id,f.owner,{...f.remote,shop:{...f.remote.shop,id:'gid://shopify/Shop/999999'}},f.events),/another store/);
   await assert.rejects(()=>service.apply(db,f.account.id,f.owner,f.remote,[{...f.events[0],subject:{id:'gid://shopify/App/0'}}]),/another subscription/);
   assert.equal(await ent.subscriptionFor(db,f.account.id),null);
  });
  await t.test('renewal preserves accepted structural limits while new plan choices use their newly published terms',async()=>{
   const f=await fixture('growth');await service.reserve(db,f.account,f.owner);
   const activated=await service.apply(db,f.account.id,f.owner,f.remote,f.events),accepted=await ent.subscriptionFor(db,f.account.id);
   const actor=(await db.query("SELECT id FROM users WHERE workspace_id=$1 AND account_id=$2 AND role='owner'",[activated.workspaceId,f.account.id])).rows[0];
   const ctx={workspaceId:activated.workspaceId,actorId:actor.id},scope={accountId:f.account.id,workspaceId:activated.workspaceId};
   const catalog=require('../../src/domain/postgres-catalog-service'),control=require('../../src/commercial/control-service');
   for(const n of [1,2])await catalog.createItem(db,ctx,{name:'Accepted Shopify product '+n,baseCode:'ACCEPTED-SHOPIFY-'+n,trackingMode:'quantity'});
   const oldCapacity=await ent.meterState(db,scope,'products');assert.equal(oldCapacity.capacityUsed,2);assert(oldCapacity.hardLimit>2);
   async function publishLimit(plan,limit){
    await db.query("UPDATE commercial_plan_meters SET included_units=$2,hard_limit=$2 WHERE plan_id=$1 AND meter='products'",[plan,limit]);
    return control.snapshotPlanVersion(db,plan,{reason:'Isolated Shopify accepted-capacity regression'});
   }
   const smallerGrowth=await publishLimit('growth',1);
   assert.notEqual(smallerGrowth.id,accepted.plan_version_id);
   assert.equal((await db.query('SELECT status FROM commercial_plan_versions WHERE id=$1',[accepted.plan_version_id])).rows[0].status,'RETIRED');
   assert.equal((await control.resourceExcess(db,scope,'growth')).products.allowed,1,'The new public version is genuinely too small for this inventory');
   const renewal={...f.remote,currentBillingCycle:{startTime:new Date(Date.now()-1).toISOString(),endTime:new Date(Date.now()+29*86400000).toISOString()}};
   await service.apply(db,f.account.id,f.owner,renewal,f.events);
   assert.equal((await ent.subscriptionFor(db,f.account.id)).plan_version_id,accepted.plan_version_id);
   const renewedCapacity=await ent.meterState(db,scope,'products');
   assert.equal(renewedCapacity.hardLimit,oldCapacity.hardLimit);
   assert.equal(renewedCapacity.capacityUsed,2);
   const newPro=await publishLimit('pro',3);
   const remotePlan=plan=>({...renewal,items:[{handle:plan,price:{__typename:'FlatRatePrice',active:true,currency:'USD',amount:(provider.PRICES[plan]/100).toFixed(2)}}]});
   await service.apply(db,f.account.id,f.owner,remotePlan('pro'),f.events);
   assert.equal((await ent.subscriptionFor(db,f.account.id)).plan_version_id,newPro.id,'A different Shopify plan accepts its current published version');
   assert.equal((await ent.meterState(db,scope,'products')).hardLimit,3);
   await publishLimit('starter',1);
   const before={subscription:(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.account.id])).rows[0],binding:await service.get(db,f.account.id),
    items:(await db.query('SELECT * FROM items WHERE workspace_id=$1 ORDER BY id',[activated.workspaceId])).rows};
   await assert.rejects(service.apply(db,f.account.id,f.owner,remotePlan('starter'),f.events),/existing inventory exceeds this Shopify plan/);
   assert.deepEqual((await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.account.id])).rows[0],before.subscription);
   assert.deepEqual(await service.get(db,f.account.id),before.binding);
   assert.deepEqual((await db.query('SELECT * FROM items WHERE workspace_id=$1 ORDER BY id',[activated.workspaceId])).rows,before.items);
  });
 }finally{await db.close();await cluster.stop();process.env=env;}
});
