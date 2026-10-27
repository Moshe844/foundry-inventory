'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('Published plan allowances govern the actual canonical services',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 const ent=require('../../src/commercial/entitlements'),scope={accountId:f.owner.accountId,workspaceId:ctx.workspaceId};
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source) VALUES('public-plan',$1,'starter','COMP','MONTHLY','ISOLATED_TEST')",[scope.accountId]);
 await t.test('a terms review without saved comparable terms stays read-only and cannot change the plan',async()=>{
  const service=require('../../src/commercial/plan-terms'),review=await service.review(db,scope.accountId);assert.equal(review.canAccept,false);assert.match(review.reason,/saved terms/);
  await assert.rejects(()=>service.accept(db,scope.accountId,{confirm:'1'}),/saved terms/);assert.equal((await ent.subscriptionFor(db,scope.accountId)).plan_version_id,null);
 });
 await t.test('reference limits are real and annual is exactly ten monthly payments',async()=>{
  for(const [id,credits,emails,users,locations,products]of [['starter',3000,1000,3,2,5000],['growth',10000,10000,10,10,50000],['pro',25000,50000,25,null,250000]]){
   await db.query('UPDATE account_subscriptions SET plan_id=$2 WHERE account_id=$1',[scope.accountId,id]);
   for(const [meter,included]of Object.entries({ai_work_credits:credits,emails_sent:emails,members:users,locations,products}))assert.equal((await ent.meterState(db,scope,meter)).included,included,id+' '+meter);
   const p=(await db.query('SELECT * FROM commercial_plans WHERE id=$1',[id])).rows[0];assert.equal(Number(p.annual_amount_minor),Number(p.monthly_amount_minor)*10);assert.equal(Number(p.trial_days),0);
  }
  assert.equal((await db.query("SELECT public_name FROM commercial_plans WHERE id='enterprise'")).rows[0].public_name,'Custom');
 });
 await t.test('new product capacity is shared by forms and bulk imports, not matched updates',async()=>{
  await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason,source) VALUES('small-product-limit',$1,'products',2,'Boundary fixture','ISOLATED_TEST')",[scope.accountId]);
  const catalog=require('../../src/domain/postgres-catalog-service');await catalog.createItem(db,ctx,{name:'Allowed second',baseCode:'SECOND',trackingMode:'quantity'});
  await assert.rejects(()=>catalog.createItem(db,ctx,{name:'Too many',baseCode:'THIRD',trackingMode:'quantity'}),/Products has reached/);
  await assert.rejects(()=>db.transaction(c=>catalog.createImportedItemsInTransaction(c,ctx,[{name:'Bulk extra',trackingMode:'quantity',variants:[{code:'FOURTH'}]}])),/Products has reached/);
  const imports=require('../../src/imports/postgres-service'),plan=await imports.analyse(db,ctx,{text:'Product,SKU,Location,Quantity\nUnfamiliar capacity import,CAPACITY-IMPORT,'+f.location.name+',1',allowModel:false});
  await assert.rejects(()=>imports.approve(db,ctx,plan.id,plan.integrityHash),/Products has reached/);
  assert.notEqual((await imports.get(db,ctx.workspaceId,plan.id)).approvalStatus,'APPROVED','an oversized import must fail before approval, not halfway through applying');
  assert.equal(Number((await ent.meterState(db,scope,'products')).used),2);
  await db.query("DELETE FROM commercial_entitlement_overrides WHERE id='small-product-limit'");
 });
 await t.test('Starter enforces one sales channel and one shipping account independently',async()=>{
  await db.query("UPDATE account_subscriptions SET plan_id='starter' WHERE account_id=$1",[scope.accountId]);
  const caps=require('../../src/commercial/connection-capacity');
  await db.transaction(c=>caps.assertActivation(c,scope,'shopify',1));
  await db.query("INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,setup_status,created_at,updated_at) VALUES('capacity-sales',$1,'sale-fixture','Store','shopify','[]','{}','connected','CONNECTED',now(),now())",[ctx.workspaceId]);
  await assert.rejects(()=>db.transaction(c=>caps.assertActivation(c,scope,'square',1)),/Sales channels has reached/);
  await assert.rejects(()=>db.transaction(c=>caps.assertActivation(c,scope,'easypost',1)),/Shipping accounts has reached/);
  await assert.rejects(()=>db.transaction(c=>caps.assertActivation(c,scope,'shipengine',1)),/Shipping accounts has reached/);
  await db.transaction(c=>caps.assertActivation(c,scope,'shopify',0));
  await db.query("UPDATE account_subscriptions SET plan_id='growth' WHERE account_id=$1",[scope.accountId]);await db.transaction(c=>caps.assertActivation(c,scope,'square',1));
 });
 await t.test('email quota reserves, commits once and releases definite rejection only',async()=>{
  await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason,source) VALUES('small-email-limit',$1,'emails_sent',1,'Boundary fixture','ISOLATED_TEST')",[scope.accountId]);
  const email=require('../../src/commercial/email-allowance'),held=await email.begin(db,ctx.workspaceId,'mail-quota-fixture');
  await email.complete(db,held);await email.complete(db,held);assert.equal((await ent.meterState(db,scope,'emails_sent')).used,1);
  await assert.rejects(()=>email.begin(db,ctx.workspaceId,'another-mail'),/Emails sent has reached/);
  await db.query("UPDATE commercial_entitlement_overrides SET limit_units=2 WHERE id='small-email-limit'");
  const rejected=await email.begin(db,ctx.workspaceId,'rejected-mail');await email.failed(db,rejected,{status:400,definiteFailure:true});
  // The provider classifier, not an arbitrary error string, controls release.
  assert.equal((await ent.meterState(db,scope,'emails_sent')).capacityUsed,1);
  const ambiguous=await email.begin(db,ctx.workspaceId,'ambiguous-mail');await email.failed(db,ambiguous,{status:503});
  assert.equal((await ent.meterState(db,scope,'emails_sent')).capacityUsed,2);
  await assert.rejects(()=>email.begin(db,ctx.workspaceId,'blocked-while-uncertain'),/Emails sent has reached/);
  await db.query("DELETE FROM commercial_entitlement_overrides WHERE id='small-email-limit'");
 });
 await t.test('connected operations have no hidden usage cutoff on the new offers',async()=>{
  const state=await ent.meterState(db,scope,'connected_operations');assert.equal(state.hardLimit,null);assert.equal(state.remaining,null);
  await ent.reserveUsage(db,scope,{meter:'connected_operations',units:100000,idempotencyKey:'connected-operation-boundary'});await ent.commitUsage(db,scope,{meter:'connected_operations',idempotencyKey:'connected-operation-boundary'});
  assert.equal((await ent.meterState(db,scope,'connected_operations')).used,100000);
 });
 await t.test('Starter gets three real schedules; editing or pausing does not consume another slot',async()=>{
  await db.query("UPDATE account_subscriptions SET plan_id='starter' WHERE account_id=$1",[scope.accountId]);
  const reports=require('../../src/reports/postgres-service'),actor={role:'owner',permissions:[],email:f.email},rows=[];
  for(let i=0;i<3;i++)rows.push(await reports.save(db,ctx,actor,{dataset:'stock',title:'Independent scheduled view '+i,columns:['sku','on_hand']},{schedule:{frequency:'weekly',hour:9,minute:17,weekday:2,timeZone:'America/New_York'}}));
  await assert.rejects(()=>reports.save(db,ctx,actor,{dataset:'stock',title:'Fourth',columns:['sku','on_hand']},{schedule:{frequency:'daily',hour:8}}),/Scheduled reports has reached/);
  await reports.save(db,ctx,actor,rows[0].definition,{id:rows[0].id,schedule:{frequency:'weekly',hour:10,paused:true}});
  assert.equal((await ent.meterState(db,scope,'scheduled_reports')).used,3);
  await db.query('UPDATE stockchief_runtime.report_templates SET deleted_at=now() WHERE id=$1',[rows[1].id]);
  await reports.save(db,ctx,actor,{dataset:'stock',title:'Replacement',columns:['sku','on_hand']},{schedule:{frequency:'daily',hour:8}});
 });
 await t.test('only unused included AI credits carry for one month and carry is consumed first',async()=>{
  const auth=require('../../src/domain/postgres-auth-service'),{randomUUID}=require('node:crypto'),fresh=await auth.createBusiness(db,{name:'Rollover owner',businessName:'Chronological rollover fixture',email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()}),scope={accountId:fresh.accountId,workspaceId:fresh.workspaceId};
  await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,source,current_period_start,current_period_end) VALUES($1,$2,'starter','monthly-offer-2026-10-27:starter','COMP','MONTHLY','ISOLATED_ROLLOVER','2026-08-01','2026-09-01')",[randomUUID(),scope.accountId]);
  await db.query("UPDATE account_subscriptions SET current_period_start='2026-08-01',current_period_end='2026-09-01' WHERE account_id=$1",[scope.accountId]);
  assert.equal((await ent.meterState(db,scope,'ai_work_credits',{now:'2026-08-15T12:00:00Z'})).rollover.units,0);
  await ent.reserveUsage(db,scope,{meter:'ai_work_credits',units:300,idempotencyKey:'august-included',occurredAt:'2026-08-15T12:00:00Z'});await ent.commitUsage(db,scope,{meter:'ai_work_credits',idempotencyKey:'august-included'});
  await db.query("UPDATE account_subscriptions SET current_period_start='2026-09-01',current_period_end='2026-10-01' WHERE account_id=$1",[scope.accountId]);
  assert.equal((await ent.meterState(db,scope,'ai_work_credits',{now:'2026-09-15T12:00:00Z'})).rollover.units,2700);
  await ent.reserveUsage(db,scope,{meter:'ai_work_credits',units:2730,idempotencyKey:'september-carry',occurredAt:'2026-09-15T12:00:00Z'});await ent.commitUsage(db,scope,{meter:'ai_work_credits',idempotencyKey:'september-carry'});
  const sept=await ent.meterState(db,scope,'ai_work_credits',{now:'2026-09-15T12:00:00Z'});assert.equal(sept.rollover.remaining,0);assert.equal(sept.includedUsed,30);
  await db.query("UPDATE account_subscriptions SET current_period_start='2026-10-01',current_period_end='2026-11-01' WHERE account_id=$1",[scope.accountId]);
  const oct=await ent.meterState(db,scope,'ai_work_credits',{now:'2026-10-15T12:00:00Z'});assert.equal(oct.rollover.units,2970);assert.equal(oct.remaining,5970);
 });
 await t.test('annual checkout selects and verifies the exact annual provider price',async()=>{
  const commercial=require('../../src/commercial/service');await db.query("UPDATE commercial_plans SET packaging_status='APPROVED',stripe_annual_price_id='price_annual_isolated' WHERE id='starter'");let received;
  const provider={retrievePrice:async id=>({id,active:true,type:'recurring',currency:'usd',unit_amount:199000,recurring:{interval:'year',interval_count:1}}),createCheckout:async input=>{received=input;return {id:'cs_annual_isolated',url:'https://billing.example.test/annual'};}};
  await commercial.beginCheckout(db,{id:scope.accountId,email:f.email},{planId:'starter',interval:'annual',origin:'https://stockchief.example.test'},{provider,testMode:true});assert.equal(received.priceId,'price_annual_isolated');assert.equal(received.trialDays,0);
  provider.retrievePrice=async id=>({id,active:true,type:'recurring',currency:'usd',unit_amount:19900,recurring:{interval:'month'}});
  await assert.rejects(()=>commercial.beginCheckout(db,{id:scope.accountId,email:f.email},{planId:'starter',interval:'annual',origin:'https://stockchief.example.test'},{provider,testMode:true}),/billing price differs/);
 });
 await t.test('capacity is granted only by the matching paid invoice; duplicates and cancellation are safe',async()=>{
  await db.query("UPDATE account_subscriptions SET current_period_start=date_trunc('month',now()),current_period_end=date_trunc('month',now())+interval '1 month',stripe_customer_id='cus_capacity_fixture' WHERE account_id=$1",[scope.accountId]);
  await db.query("UPDATE commercial_capacity_products SET stripe_price_id='price_capacity_fixture' WHERE id='extra-locations'");
  const addons=require('../../src/commercial/capacity-addons');let checkout;
  const provider={retrievePrice:async id=>({id,active:true,type:'recurring',currency:'usd',unit_amount:4900,recurring:{interval:'month'}}),createCapacityCheckout:async input=>{checkout=input;return {id:'cs_capacity_fixture',url:'https://billing.example.test/capacity'};},setCancellation:async input=>({id:input.subscriptionId,customer:'cus_capacity_fixture',cancel_at_period_end:true})};
  const input={productId:'extra-locations',quantity:2,idempotencyKey:'capacity-fixture-request',origin:'https://stockchief.example.test'},options={provider,testMode:true};
  await addons.begin(db,scope,input,options);const again=await addons.begin(db,scope,input,options);assert.equal(again.order.id,checkout.orderId);
  assert.equal((await ent.meterState(db,scope,'locations')).hardLimit,2);
  const now=Math.floor(Date.now()/1000),event=(type,object,eventId)=>({id:eventId||type,created:now,type,data:{object}}),metadata={stockchief_account_id:scope.accountId,stockchief_capacity_order_id:checkout.orderId};
  await db.transaction(c=>addons.receive(c,event('checkout.session.completed',{id:'cs_capacity_fixture',mode:'subscription',subscription:'sub_capacity_fixture',customer:'cus_capacity_fixture',metadata})));
  assert.equal((await ent.meterState(db,scope,'locations')).hardLimit,2);
  const invoice={id:'in_capacity_fixture',status:'paid',total:9800,currency:'usd',customer:'cus_capacity_fixture',subscription:'sub_capacity_fixture',lines:{has_more:false,data:[{quantity:2,price:{id:'price_capacity_fixture'},period:{start:now,end:now+86400}}]}};
  await assert.rejects(()=>db.transaction(c=>addons.receive(c,event('invoice.paid',{...invoice,customer:'cus_other'}))),/another billing account/);
  await db.transaction(c=>addons.receive(c,event('invoice.paid',invoice)));await db.transaction(c=>addons.receive(c,event('invoice.paid',invoice)));
  assert.equal((await ent.meterState(db,scope,'locations')).hardLimit,22);assert.equal((await db.query('SELECT count(*)::int n FROM commercial_capacity_payments')).rows[0].n,1);
  await assert.rejects(()=>addons.cancel(db,'unrelated-account',checkout.orderId,options),/no active billing subscription/);
  await addons.cancel(db,scope.accountId,checkout.orderId,options);assert.equal((await ent.meterState(db,scope,'locations')).hardLimit,22,'paid capacity remains until term ends');
  assert.equal((await ent.meterState(db,scope,'locations',{now:new Date((now+86401)*1000).toISOString()})).hardLimit,2);
 });
 await t.test('complex AI work reserves more of the same credits before another model call',async()=>{
  const credits=require('../../src/commercial/ai-credit-policy');assert.equal(await credits.units(db,scope,1),20);
  const key='cost-bound-credit-fixture';await ent.reserveUsage(db,scope,{meter:'ai_work_credits',units:20,idempotencyKey:key,detail:{creditPolicy:await credits.policy(db,scope)}});
  const first=await db.transaction(c=>credits.ensureFunding(c,scope,key,30,'first-provider-call'));assert.equal(first.credits,20);
  await db.query(`INSERT INTO commercial_model_cost_holds(id,account_id,workspace_id,idempotency_key,period_start,period_end,provider,model,operation,maximum_minor,actual_minor,status,detail) VALUES('credit-bound-hold',$1,$2,'credit-bound-hold',date_trunc('month',now()),date_trunc('month',now())+interval '1 month','openai','isolated-model','ask',30,5,'SETTLED',$3::jsonb)`,[scope.accountId,scope.workspaceId,JSON.stringify({fundingUsageEventId:first.eventId})]);
  await ent.commitUsage(db,scope,{meter:'ai_work_credits',idempotencyKey:key});
  const second=await db.transaction(c=>credits.ensureFunding(c,scope,key,30,'second-provider-call'));assert.equal(second.credits,20);assert.notEqual(second.eventId,first.eventId);
  assert.equal(Number((await db.query('SELECT sum(units) n FROM commercial_usage_allocations WHERE event_id=$1',[first.eventId])).rows[0].n),20,'a settled receipt must never be rewritten');
  await ent.commitUsage(db,scope,{meter:'ai_work_credits',idempotencyKey:second.fundingKey});
  const replay=await db.transaction(c=>credits.ensureFunding(c,scope,key,30,'second-provider-call'));assert.equal(replay.eventId,second.eventId);
  assert.equal(Number((await db.query("SELECT sum(units) n FROM commercial_usage_events WHERE id=$1 OR detail->>'originalFundingKey'=$2",[first.eventId,key])).rows[0].n),40);
 });
 await t.test('existing customer terms change only after an explicit same-price review, preserving recorded usage',async()=>{
  await db.query("UPDATE account_subscriptions SET plan_version_id='launch-candidate-2026-10:starter' WHERE account_id=$1",[scope.accountId]);
  assert.equal((await ent.meterState(db,scope,'ai_work_credits')).included,650);
  const terms=require('../../src/commercial/plan-terms'),review=await terms.review(db,scope.accountId),before=(await db.query('SELECT count(*)::int n,sum(units)::bigint units FROM commercial_usage_events WHERE account_id=$1',[scope.accountId])).rows[0];
  await assert.rejects(()=>terms.accept(db,scope.accountId,{currentVersion:review.current.id,nextVersion:review.next.id,confirm:'0'}),/Review the current/);
  await terms.accept(db,scope.accountId,{currentVersion:review.current.id,nextVersion:review.next.id,confirm:'1'});assert.equal((await ent.meterState(db,scope,'ai_work_credits')).included,3000);
  assert.deepEqual((await db.query('SELECT count(*)::int n,sum(units)::bigint units FROM commercial_usage_events WHERE account_id=$1',[scope.accountId])).rows[0],before);
 });
 t.diagnostic(JSON.stringify({actualPostgreSQL:true,realMoney:false,paidCalls:0}));
});
