'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('14-day cancellation refunds the original subscription payments for all six offers, with safe retries and provider checks',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const guarantee=require('../../src/commercial/subscription-guarantee'),auth=require('../../src/domain/postgres-auth-service');
 let sequence=0,latestNativeRefund;
 async function fixture(plan='starter',interval='MONTHLY',days=1){
  const key=String(++sequence),owner=await auth.createBusiness(db,{name:'Refund owner',businessName:'Refund '+key,email:randomUUID()+'@example.test',password:'Refund!'+randomUUID()}),accountId=owner.accountId;
  const sub='sub_g'+key,customer='cus_g'+key,invoice='in_g'+key,pi='pi_g'+key,amount=({starter:19900,growth:49900,pro:99900})[plan]*(interval==='ANNUAL'?10:1),paidAt=new Date(Date.now()-days*86400000);
  await db.query("UPDATE accounts SET email_verified_at=now() WHERE id=$1",[accountId]);
  await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source,stripe_customer_id,stripe_subscription_id,current_period_start,current_period_end) VALUES($1,$2,$3,'ACTIVE',$4,'SELF_SERVICE',$5,$6,$7,now()+interval '1 month')",['guarantee'+key,accountId,plan,interval,customer,sub,paidAt]);
  await db.query("INSERT INTO commercial_revenue_events(id,account_id,source_id,kind,amount_minor,currency,occurred_at,detail) VALUES($1,$2,$3,'SUBSCRIPTION',$4,'USD',$5,$6::jsonb)",['cash'+key,accountId,'invoice:'+invoice,amount,paidAt,JSON.stringify({stripeSubscriptionId:sub,stripeCashVerified:true,cashMinor:amount,paymentIntentId:pi,invoiceId:invoice,invoicePaidAt:paidAt.toISOString()})]);
  const refunds=[],calls={create:0,cancel:0};let status='active',refundStatus='succeeded',loseResponse=false,wrongCustomer=false;
  const provider={retrieveInvoice:async()=>({id:invoice,customer,subscription:sub,status:'paid',amount_paid:amount,payment_intent:pi,status_transitions:{paid_at:Math.floor(paidAt.getTime()/1000)}}),listInvoicePayments:async()=>[],retrievePaymentIntent:async()=>({id:pi,customer:wrongCustomer?'cus_foreign':customer,status:'succeeded',currency:'usd',amount_received:amount,latest_charge:{id:'ch_g'+key,disputed:false}}),retrieveSubscription:async()=>({id:sub,customer,status}),cancelImmediately:async input=>{assert.equal(input.subscriptionId,sub);calls.cancel++;status='canceled';return {id:sub,customer,status};},listRefunds:async id=>{assert.equal(id,pi);return refunds.map(r=>({...r,status:refundStatus}));},createSubscriptionRefund:async input=>{calls.create++;assert.equal(input.amount,amount);assert.equal(input.paymentIntentId,pi);assert.equal(input.accountId,accountId);const r={id:'re_g'+key,payment_intent:pi,amount,currency:'usd',status:refundStatus,created:Math.floor(Date.now()/1000),metadata:{stockchief_guarantee_id:input.requestId}};refunds.push(r);if(loseResponse){loseResponse=false;throw Error('Connection lost after Stripe accepted the refund');}return r;}};
  return {accountId,sub,customer,owner,amount,provider,calls,refunds,setPending(){refundStatus='pending';},settle(){refundStatus='succeeded';},loseResponse(){loseResponse=true;},wrongCustomer(){wrongCustomer=true;}};
 }
 async function zeroCashInvoice(f,days,credit=false){
  const invoice={id:'in_zero_'+randomUUID(),customer:f.customer,subscription:f.sub,status:'paid',currency:'usd',total:credit?1000:0,amount_paid:0,amount_due:0,starting_balance:credit?-1000:0,total_taxes:[],status_transitions:{paid_at:Math.floor((Date.now()-days*86400000)/1000)}};
  await db.query("INSERT INTO commercial_revenue_events(id,account_id,source_id,kind,amount_minor,currency,occurred_at,detail) VALUES($1,$2,$3,'SUBSCRIPTION',0,'USD',to_timestamp($4),$5::jsonb)",['cash_zero_'+randomUUID(),f.accountId,'invoice:'+invoice.id,invoice.status_transitions.paid_at,JSON.stringify({invoiceId:invoice.id,stripeSubscriptionId:f.sub,stripeCashVerified:false})]);
  const result=await require('../../src/commercial/stripe-financials').syncInvoice(db,{payload:{accountId:f.accountId,invoiceId:invoice.id}},{provider:{retrieveInvoice:async()=>invoice,listInvoicePayments:async()=>[]}});
  assert.equal(result.verified,true);assert.equal(result.cashMinor,0);
 }
 for(const plan of ['starter','growth','pro'])for(const interval of ['MONTHLY','ANNUAL'])await t.test(plan+' '+interval,async()=>{
  const f=await fixture(plan,interval);
  // Both a free initial invoice and a later zero-dollar adjustment are real
  // reconciled invoices, but neither is a card payment to refund.
  await zeroCashInvoice(f,16);await zeroCashInvoice(f,0,true);
  const state=await guarantee.quote(db,f.accountId);assert.equal(state.eligible,true);
  const requests=await Promise.all([guarantee.request(db,f.accountId),guarantee.request(db,f.accountId)]);assert.equal(requests[0].id,requests[1].id);
  const job={payload:{requestId:requests[0].id,accountId:f.accountId}};
  assert.deepEqual(await guarantee.process(db,job,{provider:f.provider}),{refunded:true,payments:1});
  assert.equal(f.calls.create,1);assert.equal(f.calls.cancel,1);assert.equal((await guarantee.quote(db,f.accountId)).request.status,'REFUNDED');
  const sub=(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.accountId])).rows[0];assert.equal(sub.status,'CANCELLED');assert(sub.refunded_at);assert(sub.refund_deletion_at);
  assert.equal(Number((await db.query("SELECT amount_minor FROM commercial_revenue_events WHERE account_id=$1 AND kind='REFUND'",[f.accountId])).rows[0].amount_minor),-f.amount);
  assert.equal((await guarantee.process(db,job,{provider:f.provider})).replayed,true);assert.equal(f.calls.create,1);
 });
 for(const plan of ['starter','growth','pro'])await t.test(plan+' native refund HTTP costs preserve public checkout',async()=>{
  const f=await fixture(plan),prior={enabled:process.env.STOCKCHIEF_CHECKOUT_ENABLED,account:process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID};
  process.env.STOCKCHIEF_CHECKOUT_ENABLED='true';process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID=require('../../src/commercial/stripe-live-fee-evidence').accountId;
  try{
   await db.query('UPDATE commercial_release_control SET checkout_enabled=true,economics_approved_at=now(),readiness_approved_at=now() WHERE singleton=true');
   await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED'");
   const release=require('../../src/commercial/release');assert.equal(await release.isOpen(db),true);
   const r=await guarantee.request(db,f.accountId),job=(await db.query("SELECT * FROM stockchief_runtime.jobs WHERE kind='commercial.subscription-guarantee' AND payload->>'requestId'=$1",[r.id])).rows[0];
   const fetch=async(input,init)=>{
    const url=new URL(input),method=init.method||'GET',values=new URLSearchParams(init.body),provider=f.provider;let value;
    if(url.pathname.startsWith('/v1/invoices/'))value=await provider.retrieveInvoice();
    else if(url.pathname==='/v1/invoice_payments')value={data:[],has_more:false};
    else if(url.pathname.startsWith('/v1/payment_intents/'))value=await provider.retrievePaymentIntent();
    else if(url.pathname.startsWith('/v1/subscriptions/'))value=method==='DELETE'?await provider.cancelImmediately({subscriptionId:f.sub}):await provider.retrieveSubscription();
    else if(url.pathname==='/v1/refunds')value=method==='GET'?{data:await provider.listRefunds(url.searchParams.get('payment_intent')),has_more:false}:await provider.createSubscriptionRefund({amount:Number(values.get('amount')),paymentIntentId:values.get('payment_intent'),accountId:values.get('metadata[stockchief_account_id]'),requestId:values.get('metadata[stockchief_guarantee_id]')});
    else throw Error('Unexpected fixture HTTP path: '+url.pathname);
    return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
   };
   await require('../../src/commercial/context').run({database:db,scope:{},requestId:job.id},()=>guarantee.process(db,{payload:job.payload},{providerOptions:{fetch,secretKey:'sk_test_fixture_only'}}));
   assert.equal(f.calls.create,1);assert.equal(f.calls.cancel,1);
   const costs=(await db.query("SELECT amount_minor,detail FROM commercial_cost_events WHERE provider='stripe_billing' AND detail->>'requestId'=$1",[job.id])).rows;
   assert(costs.length>=7,'The real HTTP adapter must record every request');
   assert(costs.every(c=>c.amount_minor!==null&&Number(c.amount_minor)===0),'Known refund HTTP requests must carry evidenced cost, including list and creation');
   assert(costs.every(c=>c.detail.providerPath&&!c.detail.providerPath.includes('?')),'Billing request evidence must retain the path without query data');
   assert(costs.some(c=>c.detail.providerPath==='/v1/refunds'&&c.detail.providerMethod==='POST'));
   assert.equal(await release.isOpen(db),true,'A successful customer refund must not close public signup');
   latestNativeRefund={f,job};
  }finally{for(const [key,value]of [['STOCKCHIEF_CHECKOUT_ENABLED',prior.enabled],['STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID',prior.account]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
 });
 await t.test('historical refund HTTP evidence reopens checkout without certifying Tax or untraced requests',async()=>{
  const {f,job}=latestNativeRefund,prior={enabled:process.env.STOCKCHIEF_CHECKOUT_ENABLED,account:process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID};
  process.env.STOCKCHIEF_CHECKOUT_ENABLED='true';process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID=require('../../src/commercial/stripe-live-fee-evidence').accountId;
  try{
   await db.query("UPDATE stockchief_runtime.jobs SET status='COMPLETED',completed_at=now() WHERE id=$1",[job.id]);
   const control=require('../../src/commercial/control-service'),release=require('../../src/commercial/release');
   const old=await control.recordCost(db,{}, {provider:'stripe_billing',operation:'http_request',unit:'request',quantity:1,providerVersion:'2026-09-30.endive',idempotencyKey:'historical-refund-http',occurredAt:new Date(new Date(job.created_at).getTime()+1).toISOString(),detail:{hostname:'api.stripe.com',httpStatus:200,requestId:job.id}});
   assert.equal(old.event.amount_minor,null);assert.equal(await release.isOpen(db),false);
   const sql=require('node:fs').readFileSync(require('node:path').join(__dirname,'../../src/db/postgres-migrations/536-refund-http-cost-evidence.sql'),'utf8');await db.query(sql);
   const repaired=(await db.query('SELECT amount_minor,rate_id,detail FROM commercial_cost_events WHERE id=$1',[old.event.id])).rows[0];assert.equal(Number(repaired.amount_minor),0);assert.equal(repaired.rate_id,null);assert.equal(repaired.detail.refundHttpEvidence,'536');assert.equal(await release.isOpen(db),true);
   await require('../../src/commercial/network').after({database:db,scope:{},requestId:job.id},{billing:true,def:{provider:'stripe',host:'api.stripe.com',version:'2026-09-30.endive'},key:'unknown-tax-in-same-context',url:'https://api.stripe.com/v1/tax/calculations?private=do-not-store',method:'POST'},true,{httpStatus:200});
   const untraced=await control.recordCost(db,{}, {provider:'stripe_billing',operation:'http_request',unit:'request',quantity:1,providerVersion:'2026-09-30.endive',idempotencyKey:'untraced-unknown-http',detail:{hostname:'api.stripe.com',httpStatus:200,requestId:'no-such-worker'}});
   await db.query(sql);
   const unknown=(await db.query("SELECT amount_minor,detail FROM commercial_cost_events WHERE idempotency_key='unknown-tax-in-same-context'")).rows[0];assert.equal(unknown.amount_minor,null);assert.equal(unknown.detail.providerPath,'/v1/tax/calculations');assert(!JSON.stringify(unknown.detail).includes('do-not-store'));
   assert.equal((await db.query('SELECT amount_minor FROM commercial_cost_events WHERE id=$1',[untraced.event.id])).rows[0].amount_minor,null);assert.equal(await release.isOpen(db),false,'Unpriced unrelated requests must still close checkout');
  }finally{for(const [key,value]of [['STOCKCHIEF_CHECKOUT_ENABLED',prior.enabled],['STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID',prior.account]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
 });
 await t.test('a zero-cash invoice alone does not start a refund window',async()=>{const f=await fixture();await db.query('DELETE FROM commercial_revenue_events WHERE account_id=$1',[f.accountId]);await zeroCashInvoice(f,1);const state=await guarantee.quote(db,f.accountId);assert.equal(state.eligible,false);assert.equal(state.deadline,null);await assert.rejects(guarantee.request(db,f.accountId),/14-day refund window/);assert.deepEqual(f.calls,{create:0,cancel:0});});
 await t.test('zero net revenue does not hide verified positive card cash',async()=>{const f=await fixture();await db.query("UPDATE commercial_revenue_events SET amount_minor=0,detail=detail||$2::jsonb WHERE account_id=$1",[f.accountId,JSON.stringify({cashMinor:f.amount,cashTaxMinor:f.amount,netCashRevenueMinor:0})]);assert.equal((await guarantee.quote(db,f.accountId)).eligible,true);});
 await t.test('expired guarantee is rejected before a Stripe operation',async()=>{const f=await fixture('starter','MONTHLY',14.001);assert.equal((await guarantee.quote(db,f.accountId)).eligible,false);await assert.rejects(guarantee.request(db,f.accountId),/14-day refund window/);assert.deepEqual(f.calls,{create:0,cancel:0});});
 await t.test('saved request stays eligible when worker runs after the deadline',async()=>{const f=await fixture('growth','MONTHLY',13.99),r=await guarantee.request(db,f.accountId);await db.query("UPDATE commercial_revenue_events SET occurred_at=now()-interval '15 days' WHERE account_id=$1",[f.accountId]);assert.equal((await guarantee.process(db,{payload:{requestId:r.id,accountId:f.accountId}},{provider:f.provider})).refunded,true);});
 await t.test('a lost provider response recovers the same refund without charging or refunding twice',async()=>{const f=await fixture(),r=await guarantee.request(db,f.accountId),job={payload:{requestId:r.id,accountId:f.accountId}};f.loseResponse();await assert.rejects(guarantee.process(db,job,{provider:f.provider}),/Connection lost/);assert.equal((await guarantee.process(db,job,{provider:f.provider})).refunded,true);assert.equal(f.calls.create,1);assert.equal(f.calls.cancel,1);});
 await t.test('pending refunds are truthful and subsequently reconcile',async()=>{const f=await fixture(),r=await guarantee.request(db,f.accountId),job={payload:{requestId:r.id,accountId:f.accountId}};f.setPending();await assert.rejects(guarantee.process(db,job,{provider:f.provider}),/processing your refund/);assert.equal((await guarantee.quote(db,f.accountId)).request.status,'PENDING');assert.equal((await db.query('SELECT refunded_at FROM account_subscriptions WHERE account_id=$1',[f.accountId])).rows[0].refunded_at,null);f.settle();assert.equal((await guarantee.process(db,job,{provider:f.provider})).refunded,true);assert.equal(f.calls.create,1);});
 await t.test('a signed refund update finishes the displayed request even after worker retries stop',async()=>{const f=await fixture(),r=await guarantee.request(db,f.accountId),job={payload:{requestId:r.id,accountId:f.accountId}};f.setPending();await assert.rejects(guarantee.process(db,job,{provider:f.provider}),/processing your refund/);const refund={...f.refunds[0],status:'succeeded'};await db.transaction(c=>require('../../src/commercial/refunds').reconcile(c,{id:'evt_guarantee_settled',created:Math.floor(Date.now()/1000)+1,data:{object:refund}},f.accountId));assert.equal((await guarantee.quote(db,f.accountId)).request.status,'REFUNDED');assert.equal(f.calls.create,1);});
 await t.test('a stale pending API read cannot replace a newer confirmed refund',async()=>{const f=await fixture(),r=await guarantee.request(db,f.accountId),job={payload:{requestId:r.id,accountId:f.accountId}};f.setPending();await assert.rejects(guarantee.process(db,job,{provider:f.provider}),/processing your refund/);const list=f.provider.listRefunds;f.provider.listRefunds=async id=>{const old=await list(id);await db.transaction(c=>require('../../src/commercial/refunds').reconcile(c,{id:'evt_guarantee_race',created:Math.floor(Date.now()/1000)+1,data:{object:{...f.refunds[0],status:'succeeded'}}},f.accountId));return old;};assert.equal((await guarantee.process(db,job,{provider:f.provider})).refunded,true);assert.equal((await guarantee.quote(db,f.accountId)).request.status,'REFUNDED');assert.equal(f.calls.create,1);});
 await t.test('another customer payment never refunds or cancels',async()=>{const f=await fixture(),r=await guarantee.request(db,f.accountId);f.wrongCustomer();await assert.rejects(guarantee.process(db,{payload:{requestId:r.id,accountId:f.accountId}},{provider:f.provider}),/original card payment/);assert.deepEqual(f.calls,{create:0,cancel:0});});
 await t.test('a foreign request cannot be processed against this account',async()=>{const a=await fixture(),b=await fixture(),r=await guarantee.request(db,a.accountId);assert.equal((await guarantee.process(db,{payload:{requestId:r.id,accountId:b.accountId}},{provider:b.provider})).skipped,'not_found');assert.equal(b.calls.create,0);});
});
