'use strict';
const {newId}=require('../lib/util'),{ValidationError}=require('../domain/errors'),entitlements=require('./entitlements'),stripe=require('./stripe-billing');
const id=v=>typeof v==='string'?v:v?.id;
async function catalog(db){return (await db.query("SELECT * FROM commercial_capacity_products WHERE active=true ORDER BY display_order,id")).rows;}
async function list(db,accountId){return (await db.query(`SELECT o.*,p.label,p.meter,p.units_per_pack,p.monthly_amount_minor FROM commercial_capacity_orders o JOIN commercial_capacity_products p ON p.id=o.product_id WHERE o.account_id=$1 ORDER BY o.created_at DESC`,[accountId])).rows;}
async function begin(db,scope,input,options={}){
 await require('./release').assertSubscriptionCheckoutOpen(db,options);await require('./wallet').assertScope(db,scope);
 const sub=await entitlements.subscriptionFor(db,scope.accountId);if(!sub?.stripe_customer_id||!entitlements.operationalAccess(sub).canOperate||sub.cancel_at_period_end)throw new ValidationError('An active renewing subscription is required to add capacity.');
 const product=(await db.query('SELECT * FROM commercial_capacity_products WHERE id=$1 AND active=true',[input.productId])).rows[0],quantity=Number(input.quantity);
 if(!product?.stripe_price_id||!Number.isSafeInteger(quantity)||quantity<1||quantity>1000||!input.idempotencyKey)throw new ValidationError('Choose a configured add-on and a quantity from 1 to 1,000.');
 if((await entitlements.meterState(db,scope,product.meter)).hardLimit===null)throw new ValidationError('Your plan already includes this capacity without a limit. No purchase is needed.');
 const provider=options.provider||stripe,remote=await provider.retrievePrice(product.stripe_price_id,options.providerOptions||{});
 if(remote.id!==product.stripe_price_id||!remote.active||remote.type!=='recurring'||remote.currency?.toUpperCase()!==product.currency||Number(remote.unit_amount)!==Number(product.monthly_amount_minor)||remote.recurring?.interval!=='month'||Number(remote.recurring.interval_count||1)!==1)throw new ValidationError('This add-on price could not be verified. No payment was taken.');
 const order=await db.transaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['capacity-order:'+scope.accountId+':'+input.idempotencyKey]);
  const prior=(await c.query('SELECT * FROM commercial_capacity_orders WHERE account_id=$1 AND request_key=$2',[scope.accountId,input.idempotencyKey])).rows[0];
  if(prior){if(prior.product_id!==product.id||Number(prior.quantity)!==quantity)throw new ValidationError('That purchase reference belongs to a different add-on.');return prior;}
  return (await c.query(`INSERT INTO commercial_capacity_orders(id,account_id,product_id,quantity,units,amount_minor,currency,price_id,stripe_customer_id,request_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[newId('capacity'),scope.accountId,product.id,quantity,quantity*Number(product.units_per_pack),quantity*Number(product.monthly_amount_minor),product.currency,product.stripe_price_id,sub.stripe_customer_id,input.idempotencyKey])).rows[0];
 },{isolation:'SERIALIZABLE',retrySafe:true});
 if(order.status!=='PENDING')return {url:input.origin+'/billing',order};
 const checkout=await provider.createCapacityCheckout({orderId:order.id,accountId:scope.accountId,customerId:sub.stripe_customer_id,priceId:order.price_id,quantity,successUrl:input.origin+'/billing?capacity=pending',cancelUrl:input.origin+'/billing?capacity=cancelled'},options.providerOptions||{});
 await db.query('UPDATE commercial_capacity_orders SET stripe_session_id=$2,updated_at=now() WHERE id=$1',[order.id,checkout.id]);return {url:checkout.url,order};
}
async function receive(client,event){
 const o=event.data?.object||{},subscriptionId=event.type.startsWith('customer.subscription.')?o.id:id(o.subscription)||id(o.parent?.subscription_details?.subscription),metadata=o.metadata||{},orderId=metadata.stockchief_capacity_order_id||o.parent?.subscription_details?.metadata?.stockchief_capacity_order_id;
 if(!orderId&&!subscriptionId)return false;
 const order=(await client.query(`SELECT * FROM commercial_capacity_orders WHERE ($1::text IS NOT NULL AND id=$1) OR ($2::text IS NOT NULL AND stripe_subscription_id=$2) FOR UPDATE`,[orderId||null,subscriptionId||null])).rows[0];
 if(!order)return false;
 if(id(o.customer)!==order.stripe_customer_id||metadata.stockchief_account_id&&metadata.stockchief_account_id!==order.account_id||order.stripe_subscription_id&&subscriptionId&&order.stripe_subscription_id!==subscriptionId)throw new ValidationError('The add-on event belongs to another billing account.');
 const at=new Date(Number(event.created||0)*1000);if(!Number.isFinite(at.getTime()))throw new ValidationError('The add-on event has no valid provider timestamp.');
 if(event.type==='checkout.session.completed'){
  if(o.id!==order.stripe_session_id||o.mode!=='subscription'||!subscriptionId)throw new ValidationError('The add-on checkout differs from its saved purchase.');
  await client.query('UPDATE commercial_capacity_orders SET stripe_subscription_id=$2,updated_at=now() WHERE id=$1',[order.id,subscriptionId]);
 }else if(event.type==='invoice.paid'){
  const lines=o.lines?.data||[],matching=lines.filter(l=>(id(l.pricing?.price_details?.price)||id(l.price)||id(l.plan))===order.price_id);
  if(o.status!=='paid'||o.lines?.has_more||matching.length!==1||Number(matching[0].quantity)!==Number(order.quantity)||String(o.currency).toUpperCase()!==order.currency||Number(o.total)!==Number(order.amount_minor))throw new ValidationError('The paid add-on invoice differs from the approved price and quantity.');
  const period=matching[0].period;if(!period?.start||!period?.end||Number(period.end)<=Number(period.start))throw new ValidationError('The add-on invoice has no valid paid period.');
  await client.query(`INSERT INTO commercial_capacity_payments(invoice_id,order_id,period_start,period_end,amount_minor,provider_event_id) VALUES($1,$2,to_timestamp($3),to_timestamp($4),$5,$6) ON CONFLICT(invoice_id) DO NOTHING`,[o.id,order.id,period.start,period.end,order.amount_minor,event.id]);
  // A delayed invoice may extend paid-through, but can never undo cancellation.
  await client.query(`UPDATE commercial_capacity_orders SET stripe_subscription_id=coalesce(stripe_subscription_id,$2),status=CASE WHEN status='CANCELLED' THEN status ELSE 'ACTIVE' END,paid_through=greatest(paid_through,to_timestamp($3)),updated_at=now() WHERE id=$1`,[order.id,subscriptionId,period.end]);
  const intent=id(o.payment_intent),intents=[...new Set([intent,...(o.payments?.data||[]).filter(p=>p.status==='paid'&&p.payment?.type==='payment_intent').map(p=>id(p.payment.payment_intent))].filter(Boolean))];
  await client.query(`INSERT INTO commercial_revenue_events(id,account_id,source_id,kind,amount_minor,currency,period_start,period_end,occurred_at,detail) VALUES($1,$2,$3,'ADDON',0,$4,to_timestamp($5),to_timestamp($6),$7,$8::jsonb) ON CONFLICT(source_id) DO NOTHING`,[newId('revenue'),order.account_id,'invoice:'+o.id,order.currency,period.start,period.end,at,JSON.stringify({capacityOrderId:order.id,invoiceId:o.id,stripeSubscriptionId:subscriptionId,paymentIntentId:intents[0]||null,paymentIntentIds:intents,stripeCashVerified:false,unverifiedAmountPaid:o.amount_paid})]);
  await require('../operations/postgres-job-queue').enqueue({query:client.query.bind(client),transaction:f=>f(client)},{kind:'commercial.stripe-invoice-sync',idempotencyKey:'stripe-invoice:'+o.id,payload:{accountId:order.account_id,invoiceId:o.id},maxAttempts:8});
 }else if(['customer.subscription.updated','customer.subscription.created','customer.subscription.deleted'].includes(event.type)){
  const item=o.items?.data?.[0];if(o.items?.has_more||o.items?.data?.length!==1||id(item?.price)!==order.price_id||Number(item.quantity)!==Number(order.quantity))throw new ValidationError('The add-on subscription differs from its saved purchase.');
  if(!order.last_event_at||at>=new Date(order.last_event_at))await client.query(`UPDATE commercial_capacity_orders SET stripe_subscription_id=$2,status=CASE WHEN $3 THEN 'CANCELLED' ELSE status END,cancel_at_period_end=$4,last_event_at=$5,updated_at=now() WHERE id=$1`,[order.id,o.id,event.type==='customer.subscription.deleted'||['canceled','incomplete_expired'].includes(o.status),Boolean(o.cancel_at_period_end),at]);
 }
 return true;
}
async function cancel(db,accountId,orderId,options={}){
 const row=(await db.query('SELECT * FROM commercial_capacity_orders WHERE id=$1 AND account_id=$2',[orderId,accountId])).rows[0];if(!row?.stripe_subscription_id)throw new ValidationError('That add-on has no active billing subscription.');
 if(row.status==='CANCELLED'||row.cancel_at_period_end)return {alreadyCancelled:true};
 const remote=await (options.provider||stripe).setCancellation({accountId,subscriptionId:row.stripe_subscription_id,customerId:row.stripe_customer_id,requestId:'capacity-cancel:'+row.id,cancelAtPeriodEnd:true},options.providerOptions||{});
 if(remote.id!==row.stripe_subscription_id||id(remote.customer)!==row.stripe_customer_id||remote.cancel_at_period_end!==true)throw new ValidationError('The provider did not confirm this add-on cancellation.');
 await db.query('UPDATE commercial_capacity_orders SET cancel_at_period_end=true,updated_at=now() WHERE id=$1',[row.id]);return {cancelledAtRenewal:true};
}
async function cancelAll(db,accountId,options={}){for(const row of await list(db,accountId))if(row.stripe_subscription_id&&row.status!=='CANCELLED'&&!row.cancel_at_period_end)await cancel(db,accountId,row.id,options);return {checked:true};}
module.exports={catalog,list,begin,receive,cancel,cancelAll};
