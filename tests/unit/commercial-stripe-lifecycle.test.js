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
  const calls=[];const fetch=async(url,options)=>{if(options.method!=='GET')calls.push({url,options,body:new URLSearchParams(options.body)});
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

function scheduledFixture(overrides={}){
 const calls=[];let attached=true;
 const subscription={id:'sub_scheduled',customer:'cus_owner',status:'active',...overrides.subscription};
 const schedule={id:'sched_owned',subscription:'sub_scheduled',customer:'cus_owner',status:'active',current_phase:{start_date:1791000000,end_date:1793678400},...overrides.schedule};
 const options={secretKey:'sk_test_fixture',fetch:async(url,request)=>{
  const path=new URL(url).pathname;const body=new URLSearchParams(request.body);calls.push({path,method:request.method,body,key:request.headers['Idempotency-Key']});
  if(request.method==='GET')return response(path.includes('/subscription_schedules/')?schedule:{...subscription,schedule:attached?'sched_owned':null});
  if(path.endsWith('/release')){if(overrides.releaseFailure)return new Response(JSON.stringify({error:{message:'Release unavailable'}}),{status:503});attached=false;return response({id:'sched_owned',status:'released',released_subscription:'sub_scheduled'});}
  if(path==='/v1/subscription_schedules/sched_owned')return response(schedule);
  if(path==='/v1/subscriptions/sub_scheduled')return response({...subscription,cancel_at_period_end:body.get('cancel_at_period_end')==='true'});
  throw Error('Unexpected Stripe mutation: '+path);
 }};
 return {calls,options};
}
const scheduledInput={subscriptionId:'sub_scheduled',customerId:'cus_owner',accountId:'acct_owner',planId:'pro',requestId:'cancel_once',changeId:'change_once'};
test('cancel at renewal releases an attached downgrade without cancelling the paid subscription immediately',async()=>{
 const f=scheduledFixture();const result=await stripe.setCancellation({...scheduledInput,cancelAtPeriodEnd:true},f.options);
 const writes=f.calls.filter(c=>c.method!=='GET');assert.deepEqual(writes.map(c=>c.path),['/v1/subscription_schedules/sched_owned/release','/v1/subscriptions/sub_scheduled']);
 assert.equal(writes[0].body.get('preserve_cancel_date'),'false');assert.equal(writes[1].body.get('cancel_at_period_end'),'true');assert.equal(result.status,'active');assert.equal(result.cancel_at_period_end,true);
 await stripe.setCancellation({...scheduledInput,cancelAtPeriodEnd:true},f.options);
 assert.equal(f.calls.filter(c=>c.path.endsWith('/release')).length,1,'retry reads the now-detached subscription');
 assert.equal(f.calls.at(-1).key,writes[1].key,'retry uses the same cancellation key');
});
test('an immediate upgrade removes the previous downgrade before updating the price',async()=>{
 const f=scheduledFixture();await stripe.updateSubscription({...scheduledInput,itemId:'si_owned',priceId:'price_pro',prorationBehavior:'always_invoice'},f.options);
 const writes=f.calls.filter(c=>c.method!=='GET');assert.match(writes[0].path,/release$/);assert.equal(writes[1].body.get('items[0][price]'),'price_pro');assert.equal(writes[1].body.get('proration_behavior'),'always_invoice');
});
test('changing a pending downgrade reuses the owned Stripe schedule',async()=>{
 const f=scheduledFixture();await stripe.scheduleDowngrade({...scheduledInput,currentPriceId:'price_pro',priceId:'price_growth',periodEnd:1793678400},f.options);
 const writes=f.calls.filter(c=>c.method!=='GET');assert.equal(writes.length,1);assert.equal(writes[0].path,'/v1/subscription_schedules/sched_owned');assert.equal(writes[0].body.get('phases[1][items][0][price]'),'price_growth');assert.equal(writes[0].body.get('phases[0][end_date]'),'1793678400');
});
test('foreign subscription or schedule identities cannot be released or changed',async()=>{
 for(const overrides of [{subscription:{customer:'cus_foreign'}},{schedule:{subscription:'sub_foreign'}},{schedule:{customer:'cus_foreign'}},{schedule:{id:'sched_foreign'}},{schedule:{status:'released'}}]){
  const f=scheduledFixture(overrides);await assert.rejects(()=>stripe.setCancellation({...scheduledInput,cancelAtPeriodEnd:true},f.options),/another/);assert.equal(f.calls.filter(c=>c.method!=='GET').length,0);
 }
});
test('failed schedule release never submits a subscription change',async()=>{
 const f=scheduledFixture({releaseFailure:true});await assert.rejects(()=>stripe.updateSubscription({...scheduledInput,itemId:'si_owned',priceId:'price_pro'},f.options),/did not confirm the operation/);assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path==='/v1/subscriptions/sub_scheduled').length,0);
});
