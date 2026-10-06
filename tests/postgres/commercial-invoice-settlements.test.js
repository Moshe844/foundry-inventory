'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');const assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');const auth=require('../../src/domain/postgres-auth-service');
const commercial=require('../../src/commercial/service');const financials=require('../../src/commercial/stripe-financials');
test('zero-cash and customer-credit invoice settlement preserves signed ownership and exact cash',{timeout:90000},async t=>{
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString);t.after(async()=>{await db.close();cluster.stop();});await migratePostgres(db);
 const b=await auth.createBusiness(db,{name:'Credit Test',businessName:'Credit',email:'credit@example.test',password:'Credit-test-password!'});
 const now=Math.floor(Date.now()/1000);const invoice={id:'in_zero_credit',status:'paid',customer:'cus_credit',subscription:'sub_credit',
  currency:'usd',amount_paid:0,total:1000,amount_due:0,starting_balance:-1000,total_taxes:[],pre_payment_credit_notes_amount:0};
 const event={id:'evt_zero_credit',type:'invoice.paid',created:now,data:{object:invoice}};
 await assert.rejects(()=>commercial.handleBillingEvent(db,event),/awaiting authoritative subscription ownership/);
 await db.query("UPDATE commercial_plans SET stripe_annual_price_id='price_annual_credit' WHERE id='starter'");
 await commercial.handleBillingEvent(db,{id:'evt_credit_sub',type:'customer.subscription.created',created:now,data:{object:{
  id:'sub_credit',customer:'cus_credit',status:'active',metadata:{stockchief_account_id:b.accountId},current_period_start:now,current_period_end:now+365*86400,
  items:{data:[{price:{id:'price_annual_credit',recurring:{interval:'year'}}}]}}}});
 await Promise.all([commercial.handleBillingEvent(db,event),commercial.handleBillingEvent(db,event)]);
 const job={payload:{accountId:b.accountId,invoiceId:invoice.id}};
 const provider={retrieveInvoice:async()=>invoice,listInvoicePayments:async()=>[]};
 assert.equal((await financials.syncInvoice(db,job,{provider})).verified,true);
 const rows=(await db.query('SELECT amount_minor,detail FROM commercial_revenue_events WHERE source_id=$1',[`invoice:${invoice.id}`])).rows;
 assert.equal(rows.length,1);assert.equal(Number(rows[0].amount_minor),0);assert.equal(rows[0].detail.stripeCashVerified,true);
 assert.equal(rows[0].detail.customerBalanceCreditMinor,1000);
 assert.equal(Number((await db.query("SELECT count(*) FROM stockchief_runtime.jobs WHERE kind='commercial.stripe-invoice-sync'")).rows[0].count),1);
 const taxCredit={...invoice,id:'in_tax_credit',total_taxes:[{amount:100}],starting_balance:-300,
  amount_due:700,amount_paid:700};
 await commercial.handleBillingEvent(db,{...event,id:'evt_tax_credit',data:{object:taxCredit}});
 const taxProvider={...provider,retrieveInvoice:async()=>taxCredit,
  listInvoicePayments:async()=>[{id:'inpay_tax',status:'paid',invoice:taxCredit.id,currency:'usd',amount_paid:700,
   payment:{type:'payment_intent',payment_intent:'pi_tax'}}],
  retrievePaymentIntent:async()=>({id:'pi_tax',status:'succeeded',customer:'cus_credit',currency:'usd',amount_received:700})};
 assert.equal((await financials.syncInvoice(db,{payload:{...job.payload,invoiceId:taxCredit.id}},
  {provider:taxProvider})).verified,true);
 const taxReceipt=(await db.query('SELECT amount_minor,detail FROM commercial_revenue_events WHERE source_id=$1',
  [`invoice:${taxCredit.id}`])).rows[0];
 assert.equal(Number(taxReceipt.amount_minor),630);assert.equal(taxReceipt.detail.cashTaxMinor,70);
 for(const [suffix,patch,payment] of [
  ['carried_debit',{starting_balance:100,amount_due:1100,amount_paid:1100},1100],
  ['overpaid',{starting_balance:0,amount_due:1000,amount_paid:1000,amount_overpaid:100},1100],
 ]){
  const candidate={...invoice,...patch,id:`in_${suffix}`};
  await commercial.handleBillingEvent(db,{...event,id:`evt_${suffix}`,data:{object:candidate}});
  const paymentId=`inpay_${suffix}`;const intentId=`pi_${suffix}`;
  const verifiedProvider={retrieveInvoice:async()=>candidate,
   listInvoicePayments:async()=>[{id:paymentId,status:'paid',invoice:candidate.id,currency:'usd',amount_paid:payment,
    payment:{type:'payment_intent',payment_intent:intentId}}],
   retrievePaymentIntent:async()=>({id:intentId,status:'succeeded',customer:'cus_credit',currency:'usd',amount_received:payment}),
   listCustomerBalanceTransactions:async()=>[{id:'cbtxn_overpaid',type:'invoice_overpaid',amount:-100,
    currency:'usd',customer:'cus_credit',invoice:candidate.id}]};
  assert.equal((await financials.syncInvoice(db,{payload:{...job.payload,invoiceId:candidate.id}},
   {provider:verifiedProvider})).verified,true);
  const receipt=(await db.query('SELECT amount_minor,detail FROM commercial_revenue_events WHERE source_id=$1',
   [`invoice:${candidate.id}`])).rows[0];
  assert.equal(Number(receipt.amount_minor),1000,`${suffix} must exclude non-current-invoice cash`);
  assert.equal(receipt.detail.stripeCashVerified,true);
  assert.equal(receipt.detail.currentInvoiceCashMinor+receipt.detail.carriedDebitCollectionMinor+
   receipt.detail.overpaymentLiabilityMinor,payment);
 }
});
