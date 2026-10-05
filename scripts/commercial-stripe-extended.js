'use strict';
const assert=require('node:assert/strict');
const auth=require('../src/domain/postgres-auth-service');const usage=require('../src/commercial/entitlements');
const financials=require('../src/commercial/stripe-financials');

async function run({call,db,product,runId,until,check,deliveries,forward,providerOptions,extraCustomers,extraClocks}){
 const annual=await call('/prices',{product:product.id,currency:'usd',unit_amount:1000,'recurring[interval]':'year'});
 await db.query("UPDATE commercial_plans SET stripe_annual_price_id=$1,annual_amount_minor=1000 WHERE id='starter'",[annual.id]);
 let sequence=0;
 async function fixture(label,values={}){
  const person=await auth.createPendingAccount(db,{name:'Extended Stripe Test',businessName:label,
   email:`extended-${++sequence}-${runId}@example.test`,password:'Extended-stripe-test-password!'});
  const customer=await call('/customers',{name:`${runId}:${label}`,email:person.email,...values});
  if(!values.test_clock)extraCustomers.push(customer.id);
  const pm=await call('/payment_methods/pm_card_visa/attach',{customer:customer.id});
  await call(`/customers/${customer.id}`,{'invoice_settings[default_payment_method]':pm.id});
  return {accountId:person.id,customer,pm,scope:{accountId:person.id}};
 }
 async function subscribe(person,values={}){
  const sub=await call('/subscriptions',{customer:person.customer.id,'items[0][price]':annual.id,
   'metadata[stockchief_account_id]':person.accountId,default_payment_method:person.pm.id,...values});
  await until(async()=>(await usage.subscriptionFor(db,person.accountId))?.stripe_subscription_id===sub.id,'extended subscription signed ownership');
  // Stripe may deliver invoice.paid before subscription.created; retry the
  // original signed delivery after ownership exists, just as Stripe retries.
  for(const entry of deliveries.filter(e=>e.status!==200&&e.event.data.object.customer===person.customer.id))await forward(entry);
  const workspace=await auth.provisionFirstWorkspace(db,person.accountId);person.scope.workspaceId=workspace.workspaceId;
  return sub;
 }
 const invoiceId=sub=>typeof sub.latest_invoice==='string'?sub.latest_invoice:sub.latest_invoice.id;
 async function reconcile(person,id,expectedCash,expectedNet){
  const event=await until(()=>deliveries.find(e=>e.type==='invoice.paid'&&e.event.data.object.id===id&&e.status===200),'extended signed paid invoice');
  await Promise.all([forward(event),forward(event)]);
  const result=await financials.syncInvoice(db,{payload:{accountId:person.accountId,invoiceId:id}},{providerOptions});
  assert.equal(result.verified,true);assert.equal(result.cashMinor,expectedCash);
  const rows=(await db.query('SELECT * FROM commercial_revenue_events WHERE source_id=$1',[`invoice:${id}`])).rows;
  assert.equal(rows.length,1);assert.equal(Number(rows[0].amount_minor),expectedNet);assert.equal(rows[0].detail.stripeCashVerified,true);
  return rows[0];
 }
 const annualClock=await call('/test_helpers/test_clocks',{frozen_time:Math.floor(Date.now()/1000),name:`annual-${runId}`});extraClocks.push(annualClock);
 const year=await fixture('Annual',{test_clock:annualClock.id});annualClock.customerId=year.customer.id;const sub=await subscribe(year);
 await reconcile(year,invoiceId(sub),1000,1000);
 const local=await usage.subscriptionFor(db,year.accountId);assert.equal(local.billing_interval,'ANNUAL');
 assert.ok(new Date(local.current_period_end)-new Date(local.current_period_start)>=365*86400000);
 await usage.recordUsage(db,year.scope,{meter:'ai_work_credits',units:10,idempotencyKey:'annual-included-consumption'});
 const firstPeriod=usage.periodBounds(local,new Date());
 assert.equal((await usage.meterState(db,year.scope,'ai_work_credits',{now:new Date(firstPeriod.end.getTime()+1)})).includedRemaining,500);
 check('Real annual subscription activates; included usage resets monthly without another annual payment',{subscriptionId:sub.id,monthlyResetEvaluation:'injected application time'});
 const end=sub.items.data[0].current_period_end||sub.current_period_end;
 await call(`/test_helpers/test_clocks/${annualClock.id}/advance`,{frozen_time:end+3660});
 await until(async()=>(await call(`/test_helpers/test_clocks/${annualClock.id}`)).status==='ready','annual test clock renewal',90000);
 const renewed=await call(`/subscriptions/${sub.id}`);const renewedId=invoiceId(renewed);assert.notEqual(renewedId,invoiceId(sub));
 let renewedInvoice=await call(`/invoices/${renewedId}`);
 if(renewedInvoice.status==='draft')renewedInvoice=await call(`/invoices/${renewedId}/finalize`,{auto_advance:false});
 if(renewedInvoice.status==='open')await call(`/invoices/${renewedId}/pay`,{});
 await reconcile(year,renewedId,1000,1000);
 await until(async()=>new Date((await usage.subscriptionFor(db,year.accountId)).current_period_start).getTime()>=end*1000,'annual renewed entitlement');
 check('Real annual test-clock renewal records one paid receipt and the new annual entitlement',{invoiceId:renewedId});
 for(const credit of [300,1000]){
  const person=await fixture(`Balance credit ${credit}`);
  await call(`/customers/${person.customer.id}/balance_transactions`,{amount:-credit,currency:'usd',description:'Synthetic certification credit, not cash'});
  const credited=await subscribe(person);const row=await reconcile(person,invoiceId(credited),1000-credit,1000-credit);
  assert.equal(row.detail.customerBalanceCreditMinor,credit);
  check('Real customer credit is not counted as new Stripe cash',{creditMinor:credit,cashMinor:1000-credit,invoiceId:invoiceId(credited)});
 }
 const coupon=await call('/coupons',{duration:'once',percent_off:25,name:`${runId} test discount`});
 const tax=await call('/tax_rates',{display_name:'Synthetic certification tax',percentage:10,inclusive:false});
 try{
  const person=await fixture('Discount and exclusive tax');
  const taxed=await subscribe(person,{'discounts[0][coupon]':coupon.id,'default_tax_rates[0]':tax.id});
  await reconcile(person,invoiceId(taxed),825,750);
  check('Real discounted taxed invoice excludes collected tax from commercial revenue',{invoiceId:invoiceId(taxed),cashMinor:825,taxMinor:75,netMinor:750,taxComplianceCertified:false});
 }finally{await call(`/tax_rates/${tax.id}`,{active:false});await call(`/coupons/${coupon.id}`,undefined,'DELETE');}
 // Stripe supports subscription partial payments for send_invoice, not ordinary
 // auto-charge subscriptions. This validates settlement, not a new public offer.
 const partial=await fixture('Partial payment and credit note');
 const partialSub=await subscribe(partial,{collection_method:'send_invoice',days_until_due:30});
 const partialId=invoiceId(partialSub);let open=await call(`/invoices/${partialId}`);
 if(open.status==='draft')open=await call(`/invoices/${partialId}/finalize`,{auto_advance:false});
 for(const amount of [400,400]){
  const intent=await call('/payment_intents',{customer:partial.customer.id,amount,currency:'usd',payment_method:partial.pm.id,
    'automatic_payment_methods[enabled]':true,'automatic_payment_methods[allow_redirects]':'never'});
  await call(`/invoices/${partialId}/attach_payment`,{payment_intent:intent.id});
  await call(`/payment_intents/${intent.id}/confirm`,{});
 }
 open=await call(`/invoices/${partialId}`);assert.equal(open.status,'open');assert.equal(open.amount_paid,800);
 assert.equal(Number((await db.query('SELECT count(*) FROM commercial_revenue_events WHERE source_id=$1',[`invoice:${partialId}`])).rows[0].count),0);
 await call('/credit_notes',{invoice:partialId,amount:200,memo:'Certification noncash adjustment'});
 const adjusted=await reconcile(partial,partialId,800,800);assert.equal(adjusted.detail.prePaymentCreditMinor,200);
 assert.equal(adjusted.detail.paidPaymentIds.length,2);
 check('Real split payments and pre-payment credit reconcile only settled Stripe cash',{invoiceId:partialId,cashMinor:800,creditMinor:200,partialPaymentScope:'send_invoice test fixture only'});
}
module.exports={run};
