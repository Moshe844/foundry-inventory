'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const {chromium}=require('playwright');const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');const {migratePostgres}=require('../../src/db/migrate-postgres');
const auth=require('../../src/domain/postgres-auth-service');const usage=require('../../src/commercial/entitlements');
const commercial=require('../../src/commercial/service');const addons=require('../../src/commercial/addons');
const costs=require('../../src/commercial/control-service');const operations=require('../../src/commercial/operations');
const release=require('../../src/commercial/release');const stripe=require('../../src/commercial/stripe-billing');
const {newId}=require('../../src/lib/util');const {createPostgresApp}=require('../../src/postgres-app');

test('approved commercial foundation: real PostgreSQL, concurrency, ledger and Chromium',{timeout:180000},async(t)=>{
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString);t.after(async()=>{await db.close();cluster.stop();});
 await migratePostgres(db);
 const business=await auth.createBusiness(db,{name:'Wallet Owner',businessName:'Wallet Business',email:'wallet@example.test',password:'wallet-password-long'});
 const other=await auth.createBusiness(db,{name:'Other Owner',businessName:'Other Business',email:'other-wallet@example.test',password:'wallet-password-long'});
 const scope={accountId:business.accountId,workspaceId:business.workspaceId};
 const now=Math.floor(Date.now()/1000);let sequence=now;
 await db.query("UPDATE accounts SET email_verified_at=now() WHERE id=$1",[business.accountId]);
 await db.query("UPDATE commercial_plans SET stripe_monthly_price_id='price_'||id,packaging_status='APPROVED'");
 const remote=(plan='starter')=>({id:'sub_wallet',customer:'cus_wallet',status:'active',current_period_start:now-86400,
  current_period_end:now+29*86400,metadata:{stockchief_account_id:business.accountId},items:{data:[{id:'si_wallet',price:{id:`price_${plan}`,recurring:{interval:'month'}}}]},default_payment_method:'pm_wallet'});
 const event=(type,object,id=newId('evt'))=>({id,type,created:++sequence,data:{object}});
 await commercial.handleBillingEvent(db,event('customer.subscription.created',remote()));
 await db.query("UPDATE commercial_plan_meters SET included_units=20 WHERE plan_id='starter' AND meter='ai_work_credits'");
 await costs.snapshotPlanVersion(db,'starter');await db.query("UPDATE account_subscriptions SET plan_version_id=(SELECT id FROM commercial_plan_versions WHERE plan_id='starter' AND status='ACTIVE') WHERE account_id=$1",[business.accountId]);
 await db.query("UPDATE commercial_usage_packs SET units=10,amount_minor=100,stripe_price_id='price_pack_'||id WHERE id='ai-500-v1'");
 const provider={createAddonCheckout:async(i)=>({id:`cs_${i.purchaseId}`,url:'https://stripe.example.test/pay'}),
  retrieveSubscription:async()=>remote(),retrievePaymentMethod:async()=>({id:'pm_wallet',customer:'cus_wallet'}),
  createTopupPayment:async(i)=>({id:`pi_${i.purchaseId}`,status:'succeeded'}),
  previewSubscriptionChange:async()=>({lines:{data:[{amount:500,proration:true}]}}),
  updateSubscription:async()=>remote('pro'),scheduleDowngrade:async()=>({id:'sched_wallet'}),listInvoices:async()=>({data:[]}),
  createCheckout:async(i)=>({id:'cs_subscription',url:i.successUrl.replace('{CHECKOUT_SESSION_ID}','cs_subscription')}),
  retrieveCheckout:async()=>({id:'cs_subscription',status:'complete',metadata:{stockchief_account_id:business.accountId},subscription:remote()})};
 const options={provider,testMode:true};
 await t.test('live release remains closed even when plan packaging is approved',async()=>{
  await assert.rejects(()=>release.assertCheckoutOpen(db),/closed/);await assert.rejects(()=>commercial.beginCheckout(db,{id:business.accountId},
   {planId:'starter'}),/closed/);assert.equal((await release.state(db)).checkout_enabled,false);
 });
 await t.test('unsupported capabilities remain disabled and aliases resolve canonically',async()=>{
  for(const key of ['communications.ai_drafts','documents.extraction','shipping.automation','adaptive_optimization'])assert.equal((await usage.capabilityState(db,scope,key)).enabled,false);
  assert.equal((await usage.capabilityState(db,scope,'ask_stockchief')).capability,'ask.lookup');
  await assert.rejects(()=>usage.assertCapability(db,scope,'warehouse.advanced'),/does not include/);
 });
 await t.test('tenant scope is checked inside the commercial service',async()=>{
  await assert.rejects(()=>usage.meterState(db,{accountId:other.accountId,workspaceId:business.workspaceId},'ai_work_credits'),/another commercial account/);
  await assert.rejects(()=>addons.beginPurchase(db,{accountId:other.accountId,workspaceId:business.workspaceId},{packId:'ai-500-v1',idempotencyKey:'tenant',origin:'http://local'},options),/another commercial account/);
 });
 await t.test('reservations, reversal and concurrent duplicate keys allocate exactly once',async()=>{
  const request={meter:'ai_work_credits',units:4,idempotencyKey:'concurrent-same'};
  const rows=await Promise.all(Array.from({length:8},()=>usage.reserveUsage(db,scope,request)));
  assert.equal(rows.filter(r=>r.created).length,1);assert.equal((await usage.meterState(db,scope,'ai_work_credits')).remaining,16);
  await usage.reverseUsage(db,scope,{meter:'ai_work_credits',idempotencyKey:'concurrent-same'});
  assert.equal((await usage.meterState(db,scope,'ai_work_credits')).remaining,20);
  await assert.rejects(()=>usage.commitUsage(db,scope,{meter:'ai_work_credits',idempotencyKey:'concurrent-same'}),/reversed/);
 });
 await t.test('annual monthly reset clamps month ends and preserves the paid-term boundary',async()=>{
  const annual={billing_interval:'ANNUAL',current_period_start:'2026-01-31T10:15:00Z',current_period_end:'2027-01-31T10:15:00Z'};
  const bounds=usage.periodBounds(annual,new Date('2026-03-01T00:00:00Z'));
  assert.equal(bounds.start.toISOString(),'2026-02-28T10:15:00.000Z');
  assert.equal(bounds.end.toISOString(),'2026-03-31T10:15:00.000Z');
 });
 await t.test('a reversed read retry re-reserves once and altered units cannot reuse its key',async()=>{
  const request={meter:'ai_work_credits',units:2,idempotencyKey:'retry-read'};
  await usage.reserveUsage(db,scope,request);await usage.reverseUsage(db,scope,request);
  const attempts=await Promise.all(Array.from({length:5},()=>usage.reserveUsage(db,scope,{...request,retryReversed:true})));
  assert.equal(attempts.filter(result=>result.created).length,1);
  await assert.rejects(()=>usage.reserveUsage(db,scope,{...request,units:3}),/different|already|match/i);
  await assert.rejects(()=>usage.commitUsage(db,{accountId:other.accountId,workspaceId:business.workspaceId},request),/another commercial account/);
  await usage.reverseUsage(db,scope,request);
  assert.equal((await usage.meterState(db,scope,'ai_work_credits')).remaining,20);
 });
 await t.test('80, 95 and 100 percent produce exactly three durable notifications',async()=>{
  for(const [key,units] of [['threshold80',16],['threshold95',3],['threshold100',1]])await usage.recordUsage(db,scope,{meter:'ai_work_credits',units,idempotencyKey:key});
  const warnings=(await db.query("SELECT threshold FROM commercial_usage_notifications WHERE account_id=$1 AND meter='ai_work_credits' ORDER BY threshold",[business.accountId])).rows;
  assert.deepEqual(warnings.map(w=>Number(w.threshold)),[80,95,100]);
  await assert.rejects(()=>usage.reserveUsage(db,scope,{meter:'ai_work_credits',idempotencyKey:'exhausted'}),/limit/);
  assert.equal((await usage.capabilityState(db,scope,'inventory.core')).enabled,true);
 });
 let purchase;
 await t.test('Buy More does not grant usage from the provider response or redirect',async()=>{
  const first=await addons.beginPurchase(db,scope,{packId:'ai-500-v1',idempotencyKey:'buy-one',origin:'http://local'},options);purchase=first.purchase;
  await addons.beginPurchase(db,scope,{packId:'ai-500-v1',idempotencyKey:'buy-one',origin:'http://local'},options);
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM commercial_usage_purchases WHERE account_id=$1',[business.accountId])).rows[0].n),1);
  assert.equal((await usage.meterState(db,scope,'ai_work_credits')).purchasedRemaining,0);
 });
 const paid=(p)=>({id:`cs_${p.id}`,mode:'payment',customer:'cus_wallet',payment_status:'paid',amount_subtotal:Number(p.amount_minor),
  currency:'usd',payment_intent:`pi_${p.id}`,metadata:{stockchief_purchase_id:p.id,stockchief_account_id:business.accountId}});
 await t.test('signed duplicate and parallel webhooks grant exactly once across event types',async()=>{
  const checkout=event('checkout.session.completed',paid(purchase));const raw=JSON.stringify(checkout);const stamp=Math.floor(Date.now()/1000);
  const signature=crypto.createHmac('sha256','whsec_fixture').update(`${stamp}.${raw}`).digest('hex');
  const verified=stripe.verifyEvent(Buffer.from(raw),{'stripe-signature':`t=${stamp},v1=${signature}`},{webhookSecret:'whsec_fixture'});
  await Promise.all([commercial.handleBillingEvent(db,verified),commercial.handleBillingEvent(db,verified),
   commercial.handleBillingEvent(db,event('payment_intent.succeeded',{id:`pi_${purchase.id}`,customer:'cus_wallet',status:'succeeded',amount_received:100,
    currency:'usd',metadata:paid(purchase).metadata}))]);
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM commercial_usage_grants WHERE purchase_id=$1',[purchase.id])).rows[0].n),1);
  assert.equal((await usage.meterState(db,scope,'ai_work_credits')).remaining,10);
 });
 await t.test('purchased capacity is concurrency-safe and failure restores its allocation',async()=>{
  const result=await Promise.allSettled(['capacity-a','capacity-b'].map(key=>usage.reserveUsage(db,scope,{meter:'ai_work_credits',units:7,idempotencyKey:key})));
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  const good=result.find(r=>r.status==='fulfilled').value;await usage.reverseUsage(db,scope,{meter:'ai_work_credits',idempotencyKey:good.event.idempotency_key});
  assert.equal((await usage.meterState(db,scope,'ai_work_credits')).remaining,10);
 });
 await t.test('purchased grants stay in their allocated inventory',async()=>{
  await db.query("UPDATE account_subscriptions SET plan_id='growth',plan_version_id=NULL WHERE account_id=$1",[business.accountId]);
  const second=await auth.createWorkspace(db,business.accountId,{name:'Second wallet inventory'});
  assert.equal((await usage.meterState(db,{accountId:business.accountId,workspaceId:second.workspaceId},'ai_work_credits')).purchasedRemaining,0);
  await db.query("UPDATE account_subscriptions SET plan_id='starter',plan_version_id=(SELECT id FROM commercial_plan_versions WHERE plan_id='starter' AND status='ACTIVE') WHERE account_id=$1",[business.accountId]);
 });
 await t.test('disputes hold funding, survive reservation reversal, release when won and revoke when lost',async()=>{
  const request={meter:'ai_work_credits',units:3,idempotencyKey:'reserve-before-dispute'};
  await usage.reserveUsage(db,scope,request);
  const dispute={id:'dp_wallet',payment_intent:`pi_${purchase.id}`,amount:100,currency:'usd',status:'needs_response'};
  const pending=event('charge.dispute.created',dispute);
  await commercial.handleBillingEvent(db,pending);
  assert.equal((await usage.meterState(db,scope,'ai_work_credits')).purchasedRemaining,0);
  await usage.reverseUsage(db,scope,request);
  assert.equal((await usage.meterState(db,scope,'ai_work_credits')).purchasedRemaining,0);
  await commercial.handleBillingEvent(db,event('charge.dispute.closed',{...dispute,status:'won'}));
  assert.equal((await usage.meterState(db,scope,'ai_work_credits')).purchasedRemaining,10);
  await commercial.handleBillingEvent(db,{...pending,id:newId('evt')});
  assert.equal((await usage.meterState(db,scope,'ai_work_credits')).purchasedRemaining,10);
  const lost=event('charge.dispute.closed',{...dispute,id:'dp_wallet_lost',amount:50,status:'lost'});
  await Promise.all([commercial.handleBillingEvent(db,lost),commercial.handleBillingEvent(db,lost)]);
  assert.equal((await usage.meterState(db,scope,'ai_work_credits')).purchasedRemaining,5);
  await assert.rejects(()=>commercial.handleBillingEvent(db,event('charge.dispute.created',{...dispute,currency:'eur'})),/currency/);
 });
 await t.test('refund revokes funded units without resurrecting reversed reservations; duplicates are harmless',async()=>{
  await usage.recordUsage(db,scope,{meter:'ai_work_credits',units:3,idempotencyKey:'spent-pack'});
  const request={meter:'ai_work_credits',units:2,idempotencyKey:'reserve-before-refund'};await usage.reserveUsage(db,scope,request);
  const refund=event('refund.created',{id:'re_wallet',status:'succeeded',payment_intent:`pi_${purchase.id}`,amount:100,currency:'usd'});
  await commercial.handleBillingEvent(db,refund);await commercial.handleBillingEvent(db,event('refund.updated',refund.data.object));
  await usage.reverseUsage(db,scope,request);
  assert.equal((await usage.meterState(db,scope,'ai_work_credits')).purchasedRemaining,0);
  assert.ok((await db.query("SELECT id FROM commercial_critical_warnings WHERE code='REFUNDED_SPENT_USAGE'")).rows.length);
 });
 await t.test('auto-top-up requires consent and verifies payment method ownership',async()=>{
  await assert.rejects(()=>addons.saveTopup(db,scope,{category:'ai_work_credits',enabled:true,packId:'ai-500-v1',monthlyCapMinor:100},options),/consent/);
  await addons.saveTopup(db,scope,{category:'ai_work_credits',enabled:true,packId:'ai-500-v1',monthlyCapMinor:100,explicitConsent:true},options);
 });
 let auto;
 await t.test('concurrent auto-top-up triggers one charge; pending charges enforce the cap',async()=>{
  const results=await Promise.all(Array.from({length:5},()=>addons.runTopup(db,scope,'ai_work_credits',options)));
  assert.equal(results.filter(r=>r.triggered).length,1);auto=(await db.query("SELECT * FROM commercial_usage_purchases WHERE kind='AUTO'")).rows[0];
  assert.equal((await usage.meterState(db,scope,'ai_work_credits')).purchasedRemaining,0);
  await commercial.handleBillingEvent(db,event('payment_intent.succeeded',{id:`pi_${auto.id}`,customer:'cus_wallet',status:'succeeded',amount_received:100,
   currency:'usd',metadata:{stockchief_purchase_id:auto.id,stockchief_account_id:business.accountId}}));
  assert.equal((await usage.meterState(db,scope,'ai_work_credits')).purchasedRemaining,10);
  await usage.recordUsage(db,scope,{meter:'ai_work_credits',units:10,idempotencyKey:'spent-auto'});
  assert.equal((await addons.runTopup(db,scope,'ai_work_credits',options)).triggered,false);
 });
 await t.test('declined upgrades retain the paid plan and unrelated paid invoices cannot end renewal grace',async()=>{
  await commercial.handleBillingEvent(db,event('invoice.payment_failed',{id:'in_failed_upgrade',customer:'cus_wallet',subscription:'sub_wallet',billing_reason:'subscription_update'}));
  assert.equal((await usage.subscriptionFor(db,business.accountId)).status,'ACTIVE');
  await commercial.handleBillingEvent(db,event('invoice.payment_failed',{id:'in_failed_renewal',customer:'cus_wallet',subscription:'sub_wallet',billing_reason:'subscription_cycle'}));
  const grace=await usage.subscriptionFor(db,business.accountId);assert.equal(grace.status,'GRACE');
  await commercial.handleBillingEvent(db,event('invoice.paid',{id:'in_unrelated_zero',customer:'cus_wallet',subscription:'sub_wallet',amount_paid:0,currency:'usd'}));
  assert.equal((await usage.subscriptionFor(db,business.accountId)).status,'GRACE');
  await commercial.handleBillingEvent(db,event('invoice.paid',{id:'in_failed_renewal',customer:'cus_wallet',subscription:'sub_wallet',amount_paid:0,currency:'usd'}));
  assert.equal((await usage.subscriptionFor(db,business.accountId)).status,'ACTIVE');
 });
 await t.test('spent monthly usage cannot prevent a next-term downgrade; structural capacity still can',async()=>{
  await db.query("UPDATE commercial_plan_meters SET hard_limit=0 WHERE plan_id='starter' AND meter='processing_units'");
  const existingExcess=await costs.resourceExcess(db,scope,'starter');
  assert.equal(existingExcess.processing_units,undefined);assert.equal(existingExcess.ai_work_credits,undefined);
  await db.query("UPDATE commercial_plan_meters SET hard_limit=0 WHERE plan_id='starter' AND meter='workspaces'");
  assert.equal((await costs.resourceExcess(db,scope,'starter')).workspaces.used,2);
  await db.query("UPDATE commercial_plan_meters SET hard_limit=1 WHERE plan_id='starter' AND meter='workspaces'");
 });
 await t.test('invoice reconciliation binds complete payments and records explicit fees before payout availability',async()=>{
  await commercial.handleBillingEvent(db,event('invoice.paid',{id:'in_reconciled',customer:'cus_wallet',subscription:'sub_wallet',
   currency:'usd',amount_paid:200,total:200,period_start:now-86400,period_end:now+29*86400}));
  const provider={retrieveInvoice:async()=>({id:'in_reconciled',status:'paid',customer:'cus_wallet',subscription:'sub_wallet',currency:'usd',amount_paid:200,total:200}),
   listInvoicePayments:async()=>[1,2].map(i=>({id:`inpay_reconcile_${i}`,invoice:'in_reconciled',status:'paid',currency:'usd',amount_paid:100,
    payment:{type:'payment_intent',payment_intent:`pi_reconcile_${i}`}})),
   retrievePaymentIntent:async id=>({id,status:'succeeded',customer:'cus_wallet',currency:'usd',amount_received:100,
    latest_charge:{id:`ch_${id}`,payment_intent:id,customer:'cus_wallet',balance_transaction:{id:`txn_${id}`,status:'pending',
     created:now,currency:'usd',amount:100,fee:33}}})};
  const financials=require('../../src/commercial/stripe-financials');
  const job={payload:{invoiceId:'in_reconciled',accountId:business.accountId}};
  assert.equal((await financials.syncInvoice(db,job,{provider})).verified,true);
  await financials.syncInvoice(db,job,{provider});
  await commercial.handleBillingEvent(db,event('invoice.paid',{id:'in_reconciled',customer:'cus_wallet',subscription:'sub_wallet',
   currency:'usd',amount_paid:200,total:200,period_start:now-86400,period_end:now+29*86400}));
  const fees=(await db.query("SELECT COUNT(*) AS n,SUM(amount_minor) AS total FROM commercial_revenue_events WHERE source_id LIKE 'stripe-fee:txn_pi_reconcile_%'")).rows[0];
  assert.equal(Number(fees.n),2);assert.equal(Number(fees.total),-66);
  assert.equal((await db.query("SELECT status FROM commercial_critical_warnings WHERE fingerprint='invoice-payments:in_reconciled'")).rows[0].status,'RESOLVED');
  const receipt=(await db.query("SELECT detail FROM commercial_revenue_events WHERE source_id='invoice:in_reconciled'")).rows[0];
  assert.equal(receipt.detail.stripeCashVerified,true);assert.equal(receipt.detail.paymentIntentIds.length,2);
  await assert.rejects(()=>financials.syncInvoice(db,{payload:{invoiceId:'in_reconciled',accountId:other.accountId}},{provider}),/ownership/);
  // Keep the original fixture's revenue assertions independent of this scenario.
  await db.query("UPDATE commercial_revenue_events SET occurred_at=now()-interval '2 years' WHERE source_id='invoice:in_reconciled'");
 });
 await t.test('actual Stripe receipts replace list-price revenue and missing rates are unknown',async()=>{
  await commercial.handleBillingEvent(db,event('invoice.paid',{id:'in_actual',customer:'cus_wallet',subscription:'sub_wallet',currency:'usd',amount_paid:17000,
   tax:1000,period_start:now-86400,period_end:now+29*86400}));
  const before=await costs.economics(db,scope);
  assert.equal(before.revenueMinor,0);assert.equal(before.contributionMarginPercent,null);
  assert.ok((await db.query("SELECT 1 FROM commercial_critical_warnings WHERE fingerprint='invoice-payments:in_actual' AND status='OPEN'")).rows.length);
  const actualProvider={retrieveInvoice:async()=>({id:'in_actual',status:'paid',customer:'cus_wallet',subscription:'sub_wallet',
   currency:'usd',amount_paid:17000,total:17000,tax:1000}),
   listInvoicePayments:async()=>[{id:'inpay_actual',invoice:'in_actual',status:'paid',currency:'usd',amount_paid:17000,
    payment:{type:'payment_intent',payment_intent:'pi_actual'}}],
   retrievePaymentIntent:async()=>({id:'pi_actual',status:'succeeded',customer:'cus_wallet',currency:'usd',amount_received:17000})};
  await require('../../src/commercial/stripe-financials').syncInvoice(db,
   {payload:{invoiceId:'in_actual',accountId:business.accountId}},{provider:actualProvider});
  const missing=await costs.recordCost(db,scope,{provider:'anthropic',model:'unknown-model',operation:'model_input',unit:'token',quantity:100,idempotencyKey:'unknown-rate'});
  assert.equal(missing.event.amount_minor,null);
  const margin=await costs.economics(db,scope);assert.equal(margin.revenueMinor,16000);assert.equal(margin.estimatedCostMinor,null);
  assert.equal(margin.contributionMarginPercent,null);assert.ok(margin.missingCostRateCount>0);
  await costs.saveCostRate(db,{provider:'anthropic',model:'fixture-model',providerVersion:'2026',operation:'model_input',unit:'token',costPerUnitMinor:.001,source:'Fixture contract',effectiveFrom:'2026-01-01'});
  const measured=await costs.recordCost(db,scope,{provider:'anthropic',model:'fixture-model',providerVersion:'2026',operation:'model_input',unit:'token',quantity:100,idempotencyKey:'versioned-rate'});
  assert.equal(Number(measured.event.amount_minor),.1);
 });
 await t.test('current Stripe invoice payments bind real fees exactly once and foreign currencies block margins',async()=>{
  await commercial.handleBillingEvent(db,event('invoice.paid',{id:'in_current_payments',customer:'cus_wallet',subscription:'sub_wallet',
   currency:'usd',amount_paid:200,period_start:now-86400,period_end:now+29*86400,
   payments:{has_more:false,data:[{id:'inpay_current',status:'paid',payment:{type:'payment_intent',payment_intent:'pi_current'}}]}}));
  const receipt=(await db.query("SELECT detail FROM commercial_revenue_events WHERE source_id='invoice:in_current_payments'")).rows[0];
  assert.deepEqual(receipt.detail.paymentIntentIds,['pi_current']);
  assert.equal((await db.query("SELECT status FROM commercial_critical_warnings WHERE fingerprint='stripe-payment-fee:pi_current'")).rows[0].status,'OPEN');
  const charge={id:'ch_current',payment_intent:'pi_current',balance_transaction:{id:'txn_current',created:now,currency:'usd',amount:200,fee:36,status:'available'}};
  await commercial.handleBillingEvent(db,event('charge.succeeded',charge));
  await commercial.handleBillingEvent(db,event('charge.updated',charge));
  assert.equal(Number((await db.query("SELECT COUNT(*) AS count FROM commercial_revenue_events WHERE source_id='stripe-fee:txn_current'")).rows[0].count),1);
  assert.equal((await db.query("SELECT status FROM commercial_critical_warnings WHERE fingerprint='stripe-payment-fee:pi_current'")).rows[0].status,'RESOLVED');
  await db.query(`INSERT INTO commercial_revenue_events(id,account_id,source_id,kind,amount_minor,currency,occurred_at)
   VALUES($1,$2,'fixture:foreign-currency','SUBSCRIPTION',1000,'EUR',now())`,[newId('revenue'),business.accountId]);
  const margin=await costs.economics(db,scope);assert.equal(margin.unsupportedRevenueCurrencyCount,1);
  assert.equal(margin.contributionMarginPercent,null);assert.equal(margin.costCoverage,'MISSING');
 });
 await t.test('upgrades await webhook and downgrades schedule rather than changing the current Stripe price',async()=>{
  let called=0;const countingOptions={...options,provider:{...provider,updateSubscription:async(...args)=>{called++;return provider.updateSubscription(...args);}}};
  const changes=await Promise.all(Array.from({length:5},()=>commercial.requestSubscriptionChange(db,business.accountId,{planId:'pro',interval:'monthly'},countingOptions)));
  assert.equal(called,1);assert.equal(new Set(changes.map(c=>c.changeId)).size,1);
  const changed=changes[0];
  assert.equal(changed.status,'PENDING');assert.equal((await usage.subscriptionFor(db,business.accountId)).plan_id,'starter');
  await commercial.handleBillingEvent(db,event('customer.subscription.updated',remote('pro')));
  assert.equal((await usage.capabilityState(db,scope,'api.public')).enabled,true);
  const downgrade=await commercial.requestSubscriptionChange(db,business.accountId,{planId:'growth',interval:'monthly'},options);
  assert.equal(downgrade.status,'PENDING');assert.equal((await usage.subscriptionFor(db,business.accountId)).plan_id,'pro');
 });
 await t.test('failed subscription payment enters fixed grace and unrelated invoices cannot restore it',async()=>{
  await commercial.handleBillingEvent(db,event('invoice.payment_failed',{id:'in_failed',customer:'cus_wallet',subscription:'sub_wallet'}));
  const first=await usage.subscriptionFor(db,business.accountId);assert.equal(first.status,'GRACE');
  await commercial.handleBillingEvent(db,event('invoice.payment_failed',{id:'in_failed_again',customer:'cus_wallet',subscription:'sub_wallet'}));
  assert.equal(String((await usage.subscriptionFor(db,business.accountId)).grace_ends_at),String(first.grace_ends_at));
  await assert.rejects(()=>commercial.handleBillingEvent(db,event('invoice.paid',{id:'in_unrelated',customer:'cus_wallet',
    subscription:'sub_other',amount_paid:100,currency:'usd'})),/awaiting authoritative subscription ownership/);
  assert.equal((await usage.subscriptionFor(db,business.accountId)).status,'GRACE');
  await db.query("UPDATE account_subscriptions SET grace_ends_at=now()-interval '1 day' WHERE account_id=$1",[business.accountId]);
  await assert.rejects(()=>usage.reserveUsage(db,scope,{meter:'ai_work_credits',idempotencyKey:'expired-grace'}),/read-only/);
  await commercial.handleBillingEvent(db,event('invoice.paid',{id:'in_failed_again',customer:'cus_wallet',subscription:'sub_wallet',amount_paid:99900,currency:'usd'}));
  assert.equal((await usage.subscriptionFor(db,business.accountId)).status,'ACTIVE');
 });
 await t.test('provider exhaustion blocks before invocation; failed operations reverse customer usage and retain cost',async()=>{
  let called=0;await assert.rejects(()=>operations.run(db,business.workspaceId,{capability:'communications.ai_drafts',key:'disabled-email',provider:'gmail',operation:'draft'},async()=>{called++;}),/does not include/);assert.equal(called,0);
  const before=(await usage.meterState(db,scope,'connected_operations')).remaining;
  await assert.rejects(()=>operations.run(db,business.workspaceId,{capability:'connections.commerce',key:'failed-provider',provider:'shopify',operation:'catalog_sync'},async()=>{throw new Error('Provider failed');}),/Provider failed/);
  assert.equal((await usage.meterState(db,scope,'connected_operations')).remaining,before);
  assert.ok((await db.query("SELECT id FROM commercial_cost_events WHERE detail->>'attempted'='true' AND operation='catalog_sync'")).rows.length);
 });
 await t.test('exhausted background work pauses durably and resumes after funding is restored',async()=>{
  const jobs=require('../../src/operations/postgres-job-queue');const runtime=require('../../src/operations/postgres-runtime-handlers');
  await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason)
    VALUES('pause-test',$1,'connected_operations',0,'Disposable exhaustion test')`,[business.accountId]);
  let calls=0;const handler=async(job,database)=>operations.run(database,job.workspaceId,
    {capability:'connections.commerce',key:job.idempotencyKey,provider:'fixture',operation:'scheduled_read'},async()=>{calls++;return {ok:true};});
  handler.externalEffect=true;
  const queued=await jobs.enqueue(db,{workspaceId:business.workspaceId,kind:'test.commercial-paused',idempotencyKey:'paused-read',payload:{}});
  const paused=await jobs.processOne(db,{'test.commercial-paused':handler},{owner:'commercial-pause-test',leaseMs:120000});
  assert.equal(paused.status,'PAUSED');assert.equal(calls,0);
  assert.equal((await jobs.get(db,queued.job.id,business.workspaceId)).attemptCount,0);
  await db.query("UPDATE commercial_entitlement_overrides SET limit_units=10 WHERE id='pause-test'");
  await db.transaction(client=>runtime.runtimeSweep({payload:{now:Date.now()}},client));
  const complete=await jobs.processOne(db,{'test.commercial-paused':handler},{owner:'commercial-pause-test',leaseMs:120000});
  assert.equal(complete.status,'COMPLETED');assert.equal(calls,1);
  await db.query("DELETE FROM commercial_entitlement_overrides WHERE id='pause-test'");
 });
 await t.test('commercial denial preserves the pending provider intent',async()=>{
  const effects=require('../../src/operations/postgres-provider-effects');
  const pending=await effects.enqueue(db,{workspaceId:business.workspaceId,kind:'payment.request.create',provider:'fixture',
    aggregateType:'payment_request',aggregateId:'pause-fixture',idempotencyKey:'effect-pause-fixture',payload:{}});
  const claim=await effects.claim(db,business.workspaceId,pending.effect.id);
  const held=await effects.finishError(db,business.workspaceId,pending.effect.id,claim.effect.claimToken,
    new usage.EntitlementError('No funded usage.',{meter:'connected_operations'}),{apply:()=>{throw new Error('A quota denial must not apply a provider rejection.');}});
  assert.equal(held.status,'PENDING');assert.equal(held.claimToken,null);
 });
 await t.test('real Chromium shows capability pricing, two usage categories and closed purchase controls',async()=>{
  const app=createPostgresApp({database:db,env:'test',sessionSecret:'wallet-browser-test-long',commercialOptions:{billingProvider:provider,loadInvoices:false,publicOrigin:'request'}});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const browser=await chromium.launch();
  try{const page=await browser.newPage();const base=`http://127.0.0.1:${server.address().port}`;
   await page.goto(`${base}/pricing`);assert.equal(await page.getByText('View usage details',{exact:true}).count(),4);
   assert.doesNotMatch(await page.locator('body').innerText(),/AI communication drafts|Routine auto-send|Business-email understanding/);
   await page.goto(`${base}/login`);await page.getByLabel('Email').fill('wallet@example.test');await page.locator('input[name="password"]').fill('wallet-password-long');if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('wallet-password-long');
   await Promise.all([page.waitForURL(`${base}/`),page.getByRole('button',{name:'Sign in'}).click()]);await page.goto(`${base}/billing`);
   assert.equal(await page.locator('[data-usage-category]').count(),2);assert.match(await page.locator('body').innerText(),/Plan & Usage/);
   const buy=page.locator('form[action="/billing/buy-more"] button').first();await buy.locator('..').locator('..').evaluate(e=>e.open=true);assert.equal(await buy.isDisabled(),true);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();}
 });
});
