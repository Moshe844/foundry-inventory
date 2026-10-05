'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const stripe=require('../../src/commercial/stripe-billing');

function response(payload){return new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});}

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
