'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const stripe=require('../../src/commercial/stripe-billing');

function response(payload){return new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});}

test('self-service portal is payment-method-only and cannot expose annual Price selection',async()=>{
 let body;await stripe.createPortal({accountId:'acct_fixture',requestId:'req_fixture',customerId:'cus_fixture',
  subscriptionId:'sub_fixture',returnUrl:'https://stockchief.example.test/billing'},
  {secretKey:'sk_test_fixture',fetch:async(_url,options)=>{body=new URLSearchParams(options.body);return response({id:'bps_fixture'});}});
 assert.equal(body.get('flow_data[type]'),'payment_method_update');
 assert.equal(body.get('flow_data[after_completion][type]'),'redirect');
 assert.equal(body.has('flow_data[subscription_update][subscription]'),false);
});

test('Stripe subscription lifecycle requests are idempotent and carry the exact requested plan',async()=>{
  const calls=[];const fetch=async(url,options)=>{calls.push({url,options,body:new URLSearchParams(options.body)});
    if(url.includes('/invoices/create_preview'))return response({id:'upcoming_1',lines:{data:[{amount:2500,proration:true}]}});
    return response({id:'sub_1',status:'active'});};
  await stripe.previewSubscriptionChange({customerId:'cus_1',subscriptionId:'sub_1',itemId:'si_1',priceId:'price_pro',
    prorationDate:1791200000},{secretKey:'sk_test_lifecycle',fetch});
  await stripe.updateSubscription({changeId:'change_1',accountId:'acct_1',planId:'pro',subscriptionId:'sub_1',itemId:'si_1',
    priceId:'price_pro',prorationBehavior:'always_invoice',paymentBehavior:'pending_if_incomplete',prorationDate:1791200000},
  {secretKey:'sk_test_lifecycle',fetch});
  await stripe.setCancellation({accountId:'acct_1',planId:'pro',subscriptionId:'sub_1',requestId:'cancel_1',cancelAtPeriodEnd:true},
  {secretKey:'sk_test_lifecycle',fetch});
  assert.match(calls[0].url,/\/invoices\/create_preview$/);assert.equal(calls[0].body.get('subscription'),'sub_1');
  assert.equal(calls[0].body.get('subscription_details[items][0][price]'),'price_pro');
  assert.match(calls[1].url,/\/subscriptions\/sub_1$/);assert.equal(calls[1].body.get('items[0][id]'),'si_1');
  assert.equal(calls[1].body.get('items[0][price]'),'price_pro');assert.equal(calls[1].body.get('proration_behavior'),'always_invoice');
  assert.equal(calls[1].options.headers['Idempotency-Key'],'stockchief-subscription-change:change_1');
  assert.equal(calls[2].body.get('cancel_at_period_end'),'true');
  assert.equal(calls[2].options.headers['Idempotency-Key'],'stockchief-subscription-cancellation:sub_1:cancel_1');
});

test('downgrade preview omits the proration date when Stripe proration is disabled',async()=>{
 let body;await stripe.previewSubscriptionChange({customerId:'cus_1',subscriptionId:'sub_1',itemId:'si_1',
  priceId:'price_starter',prorationBehavior:'none',prorationDate:1791200000},{secretKey:'sk_test_fixture',fetch:async(url,options)=>{
   body=new URLSearchParams(options.body);return response({id:'preview_down'});
  }});
 assert.equal(body.get('subscription_details[proration_behavior]'),'none');
 assert.equal(body.has('subscription_details[proration_date]'),false);
});

test('invoice payment reconciliation reads all pages and rejects repeated cursors',async()=>{
 const urls=[];const options={secretKey:'sk_test_fixture',fetch:async url=>{
  urls.push(url);return response(url.includes('starting_after')?{data:[{id:'inpay_2'}],has_more:false}:
   {data:[{id:'inpay_1'}],has_more:true});}};
 const rows=await stripe.listInvoicePayments('in_fixture',options);
 assert.deepEqual(rows.map(x=>x.id),['inpay_1','inpay_2']);assert.match(urls[1],/starting_after=inpay_1/);
 await assert.rejects(()=>stripe.listInvoicePayments('in_fixture',{secretKey:'sk_test_fixture',fetch:async()=>
  response({data:[{id:'inpay_loop'}],has_more:true})}),/repeated/);
});
test('credit-note and invoice-linked balance evidence paginate without losing settlement rows',async()=>{
 const seen=[];const options={secretKey:'sk_test_fixture',fetch:async url=>{
  seen.push(url);return response(url.includes('starting_after')?{data:[{id:'row_2'}],has_more:false}:
   {data:[{id:'row_1'}],has_more:true});}};
 assert.deepEqual((await stripe.listCreditNotes('in_fixture',options)).map(row=>row.id),['row_1','row_2']);
 assert.deepEqual((await stripe.listCustomerBalanceTransactions('cus_fixture','in_fixture',options)).map(row=>row.id),
  ['row_1','row_2']);
 assert.ok(seen.some(url=>url.includes('/customers/cus_fixture/balance_transactions?invoice=in_fixture')));
 await assert.rejects(()=>stripe.listCustomerBalanceTransactions('cus_fixture','in_fixture',
  {secretKey:'sk_test_fixture',fetch:async()=>response({data:[{id:'loop'}],has_more:true})}),/repeated/);
});

test('webhook secret rotation accepts only explicitly bounded overlap and still rejects stale signatures',()=>{
 const crypto=require('node:crypto');const raw=JSON.stringify({id:'evt_rotation',type:'invoice.paid'});
 const now=Math.floor(Date.now()/1000);
 const signature=(secret,time=now)=>`t=${time},v1=${crypto.createHmac('sha256',secret).update(`${time}.${raw}`).digest('hex')}`;
 const options={webhookSecret:'whsec_current',previousWebhookSecret:'whsec_previous',previousWebhookSecretExpiresAt:new Date(Date.now()+60000).toISOString()};
 assert.equal(stripe.verifyEvent(raw,{'stripe-signature':signature('whsec_current')},options).id,'evt_rotation');
 assert.equal(stripe.verifyEvent(raw,{'stripe-signature':signature('whsec_previous')},options).id,'evt_rotation');
 for(const deadline of [null,'invalid',new Date(Date.now()-1).toISOString()])assert.throws(()=>stripe.verifyEvent(raw,
  {'stripe-signature':signature('whsec_previous')},{...options,previousWebhookSecretExpiresAt:deadline}),/did not come/);
 assert.throws(()=>stripe.verifyEvent(raw,{'stripe-signature':signature('whsec_previous',now-301)},options),/too old/);
 assert.throws(()=>stripe.verifyEvent(raw,{'stripe-signature':signature('whsec_unknown')},options),/did not come/);
});
