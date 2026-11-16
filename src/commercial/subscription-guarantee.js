'use strict';
const {ValidationError}=require('../domain/errors'),{newId}=require('../lib/util');
const DAYS=14*86400000,identity=v=>typeof v==='string'?v:v?.id,paidAt=r=>new Date(r.detail.invoicePaidAt||r.occurred_at);
async function receipts(db,accountId){return (await db.query(`SELECT * FROM commercial_revenue_events WHERE account_id=$1 AND kind='SUBSCRIPTION' AND detail->>'stripeCashVerified'='true' ORDER BY occurred_at,id`,[accountId])).rows;}
async function quote(db,accountId){
 const sub=(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[accountId])).rows[0];
 const request=sub?.stripe_subscription_id?(await db.query('SELECT * FROM commercial_guarantee_requests WHERE account_id=$1 AND stripe_subscription_id=$2',[accountId,sub.stripe_subscription_id])).rows[0]:null;
 const paid=await receipts(db,accountId),first=paid[0],deadline=first?new Date(paidAt(first).getTime()+DAYS):null;
 return {request,deadline,eligible:Boolean(sub?.stripe_subscription_id&&!sub.refunded_at&&first&&Date.now()<=deadline.getTime()&&first.detail.stripeSubscriptionId===sub.stripe_subscription_id),sub};
}
async function request(db,accountId){return db.transaction(async c=>{
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['subscription-guarantee:'+accountId]);
 const state=await quote(c,accountId);if(state.request)return state.request;
 if(!state.eligible)throw new ValidationError('The 14-day refund window is not available for this subscription. Contact support if a payment is still being confirmed.');
 const id=newId('guarantee'),row=(await c.query(`INSERT INTO commercial_guarantee_requests(id,account_id,stripe_subscription_id) VALUES($1,$2,$3) RETURNING *`,[id,accountId,state.sub.stripe_subscription_id])).rows[0];
 await require('../operations/postgres-job-queue').enqueue({query:c.query.bind(c),transaction:fn=>fn(c)},{kind:'commercial.subscription-guarantee',idempotencyKey:id,payload:{requestId:id,accountId},maxAttempts:12});
 return row;
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function process(db,job,options={}){
 const row=(await db.query('SELECT * FROM commercial_guarantee_requests WHERE id=$1 AND account_id=$2',[job.payload.requestId,job.payload.accountId])).rows[0];
 if(!row)return {skipped:'not_found'};if(row.status==='REFUNDED')return {replayed:true};
 const provider=options.provider||require('./stripe-billing'),opts=options.providerOptions||{};
 try{
 const sub=(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[row.account_id])).rows[0];
 if(sub?.stripe_subscription_id!==row.stripe_subscription_id)throw new ValidationError('The subscription changed. Support must review this refund.');
 const paid=await receipts(db,row.account_id),first=paid[0];
 if(!first||first.detail.stripeSubscriptionId!==row.stripe_subscription_id||new Date(row.requested_at)-paidAt(first)>DAYS)throw new ValidationError('The first payment and refund window could not be verified.');
 let parts=row.parts;
 if(!parts.length){
  parts=[];
  for(const receipt of paid.filter(r=>r.detail.stripeSubscriptionId===row.stripe_subscription_id)){
   const invoice=await provider.retrieveInvoice(receipt.detail.invoiceId,opts);
   if(invoice.id!==receipt.detail.invoiceId||identity(invoice.customer)!==sub.stripe_customer_id||identity(invoice.subscription||invoice.parent?.subscription_details?.subscription)!==row.stripe_subscription_id||invoice.status!=='paid')throw new ValidationError('The invoice does not match this subscription.');
   if(receipt.id===first.id&&invoice.status_transitions?.paid_at&&new Date(row.requested_at).getTime()-invoice.status_transitions.paid_at*1000>DAYS)throw new ValidationError('The original payment is outside the 14-day refund window. Contact support.');
   const payments=await provider.listInvoicePayments(invoice.id,opts);
   const ids=[...new Set([identity(invoice.payment_intent),...payments.filter(p=>p.status==='paid'&&p.payment?.type==='payment_intent').map(p=>identity(p.payment.payment_intent))].filter(Boolean))];
   let total=0;
   for(const piId of ids){const pi=await provider.retrievePaymentIntent(piId,opts),charge=pi.latest_charge;
    if(pi.id!==piId||identity(pi.customer)!==sub.stripe_customer_id||pi.status!=='succeeded'||String(pi.currency).toUpperCase()!==receipt.currency||!Number.isSafeInteger(pi.amount_received)||pi.amount_received<=0||!charge?.id||charge.disputed)throw new ValidationError('The original card payment needs support review.');
    if(parts.some(p=>p.paymentIntentId===piId))throw new ValidationError('The same payment appears on more than one invoice.');
    total+=pi.amount_received;parts.push({paymentIntentId:piId,amount:pi.amount_received,currency:receipt.currency,invoiceId:invoice.id});
   }
   if(!ids.length||total!==invoice.amount_paid)throw new ValidationError('The invoice cash payments do not match. Support must review the refund.');
  }
  if(!parts.length)throw new ValidationError('No original subscription payment could be verified.');
  await db.query("UPDATE commercial_guarantee_requests SET parts=$2::jsonb,status='PROCESSING',updated_at=now() WHERE id=$1",[row.id,JSON.stringify(parts)]);
 }
 const current=await provider.retrieveSubscription(row.stripe_subscription_id,opts);
 if(current.id!==row.stripe_subscription_id||identity(current.customer)!==sub.stripe_customer_id)throw new ValidationError('The billing account does not match.');
 const cancelled=current.status==='canceled'?current:await provider.cancelImmediately({subscriptionId:row.stripe_subscription_id,refundId:row.id},opts);
 if(cancelled.id!==row.stripe_subscription_id||identity(cancelled.customer)!==sub.stripe_customer_id||cancelled.status!=='canceled')throw new ValidationError('Stripe has not confirmed cancellation.');
 await db.query("UPDATE account_subscriptions SET status='CANCELLED',cancel_at_period_end=0,cancelled_at=coalesce(cancelled_at,now()),updated_at=now() WHERE account_id=$1 AND stripe_subscription_id=$2",[row.account_id,row.stripe_subscription_id]);
 await require('./capacity-addons').cancelAll(db,row.account_id,options);
 let pending=false;
 for(const part of parts){
  // Search on every retry, including retries after Stripe's 24-hour idempotency retention.
  const existing=await provider.listRefunds(part.paymentIntentId,opts);
  let refund=existing.find(r=>r.metadata?.stockchief_guarantee_id===row.id);
  if(!refund){if(existing.some(r=>!['failed','canceled'].includes(r.status)))throw new ValidationError('An earlier refund needs support review before any additional money is returned.');
   refund=await provider.createSubscriptionRefund({...part,requestId:row.id,accountId:row.account_id},opts);}
  if(identity(refund.payment_intent)!==part.paymentIntentId||refund.amount!==part.amount||String(refund.currency).toUpperCase()!==part.currency||refund.metadata?.stockchief_guarantee_id!==row.id)throw new ValidationError('Stripe returned a refund that does not match the original payment.');
  if(['failed','canceled','requires_action'].includes(refund.status))throw new ValidationError('Stripe could not complete the refund. Support must review it; it has not been refunded again.');
  if(!['succeeded','pending'].includes(refund.status))throw new ValidationError('Stripe returned an unrecognized refund status.');
  // Authoritative API response: this is not a fabricated signed webhook.
  await db.transaction(c=>require('./refunds').reconcile(c,{id:'api-refund:'+refund.id,created:refund.created,data:{object:refund}},row.account_id));
  pending ||= refund.status!=='succeeded';
 }
 await db.query('UPDATE commercial_guarantee_requests SET status=$2,last_error=NULL,updated_at=now() WHERE id=$1',[row.id,pending?'PENDING':'REFUNDED']);
 if(pending)throw new ValidationError('Stripe is processing your refund. Renewal is stopped; StockChief will check again.');
 return {refunded:true,payments:parts.length};
 }catch(error){await db.query("UPDATE commercial_guarantee_requests SET status=CASE WHEN status='PENDING' THEN status ELSE 'REVIEW' END,last_error=$2,updated_at=now() WHERE id=$1",[row.id,String(error.message).slice(0,700)]);throw error;}
}
module.exports={quote,request,process};
