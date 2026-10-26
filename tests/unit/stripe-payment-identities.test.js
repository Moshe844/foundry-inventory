'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),stripe=require('../../src/payments/providers/stripe');
const event=invoice=>({type:'invoice.paid',data:{object:{id:'in_fixture',amount_paid:725,currency:'usd',status:'paid',...invoice}}});
const paid=(id,amount=725)=>({status:'paid',amount_paid:amount,payment:{type:'payment_intent',payment_intent:id}});
test('current invoice-payment evidence supplies a unique refund target without confusing unpaid intent records',()=>{
 const read=stripe.readEvent(event({payments:{data:[paid('pi_settled'),{status:'open',amount_paid:0,payment:{type:'payment_intent',payment_intent:'pi_unpaid'}}],has_more:false}}));assert.equal(read.externalPaymentId,'pi_settled');assert.equal(read.amountMinor,725);
 assert.equal(stripe.readEvent(event({payments:{data:[paid({id:'pi_expanded'})],has_more:false}})).externalPaymentId,'pi_expanded');
});
test('ambiguous, incomplete and non-card paid evidence cannot select an arbitrary refund target',()=>{
 for(const payments of [{data:[paid('pi_first',300),paid('pi_second',425)],has_more:false},{data:[paid('pi_first')],has_more:true},{data:[paid('pi_partial',300)],has_more:false},{data:[{status:'paid',amount_paid:725,payment:{type:'payment_record',payment_record:'pyr_external',payment_intent:'pi_unrelated'}}],has_more:false}])assert.equal(stripe.readEvent(event({payments})).externalPaymentId,null);
});
test('legacy invoice identities and expanded legacy values retain their refund identity',()=>{
 assert.equal(stripe.readEvent(event({payment_intent:'pi_legacy'})).externalPaymentId,'pi_legacy');
 assert.equal(stripe.readEvent(event({payment_intent:{id:'pi_legacy_expanded'}})).externalPaymentId,'pi_legacy_expanded');
 assert.equal(stripe.readEvent(event({charge:'ch_legacy'})).externalPaymentId,'ch_legacy');
});
test('refunds use the actual intent or charge type and reject unknown identities before a provider call',async t=>{
 const original=global.fetch,requests=[];t.after(()=>{global.fetch=original;});global.fetch=async(url,init)=>{requests.push({url,init});return new Response(JSON.stringify({id:'re_fixture'}),{status:200,headers:{'content-type':'application/json'}});};
 const ctx={stripeSecretKey:'sk_test_identity_fixture',stripeAccountId:'acct_fixture'};
 await stripe.refundPayment(ctx,{externalPaymentId:'pi_settled',amountMinor:725});assert.equal(requests[0].init.body.get('payment_intent'),'pi_settled');assert.equal(requests[0].init.body.get('charge'),null);
 await stripe.refundPayment(ctx,{externalPaymentId:'ch_settled',amountMinor:725});assert.equal(requests[1].init.body.get('charge'),'ch_settled');assert.equal(requests[1].init.body.get('payment_intent'),null);assert.equal(requests[1].init.headers['Stripe-Account'],'acct_fixture');
 await assert.rejects(stripe.refundPayment(ctx,{externalPaymentId:'invoice_is_not_payment',amountMinor:725}),/payment|refund|identity/i);assert.equal(requests.length,2);
});
