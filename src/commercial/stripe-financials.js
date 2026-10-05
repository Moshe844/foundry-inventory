'use strict';
const {newId}=require('../lib/util');
const jobs=require('../operations/postgres-job-queue');
const stripe=require('./stripe-billing');
async function warning(db,fingerprint,code,detail,accountId=null){await db.query(`INSERT INTO commercial_critical_warnings
 (id,account_id,fingerprint,code,detail) VALUES($1,$2,$3,$4,$5::jsonb)
 ON CONFLICT(fingerprint) DO UPDATE SET status='OPEN',code=EXCLUDED.code,detail=EXCLUDED.detail`,
 [newId('critical'),accountId,fingerprint,code,JSON.stringify(detail)]);}
async function owner(db,object){const intent=typeof object.payment_intent==='string'?object.payment_intent:object.payment_intent?.id;
 const purchase=intent?(await db.query('SELECT account_id FROM commercial_usage_purchases WHERE stripe_payment_intent_id=$1',[intent])).rows[0]:null;
 if(purchase)return purchase.account_id;
 const receipt=intent?(await db.query("SELECT account_id FROM commercial_revenue_events WHERE detail->>'paymentIntentId'=$1 OR detail->'paymentIntentIds' ? $1 LIMIT 1",[intent])).rows[0]:null;
 if(receipt)return receipt.account_id;
 const customer=typeof object.customer==='string'?object.customer:object.customer?.id;
 return customer?(await db.query('SELECT account_id FROM account_subscriptions WHERE stripe_customer_id=$1',[customer])).rows[0]?.account_id:null;}
async function balance(db,accountId,row,kind){if(!row?.id)return false;
 // Stripe's pending/available status describes payout availability, not whether
 // its explicit fee is known. Never substitute zero for an absent fee.
 const at=new Date(Number(row.created)*1000);const currency=String(row.currency).toUpperCase();
 if(kind==='DISPUTE')await db.query(`INSERT INTO commercial_revenue_events
 (id,account_id,source_id,kind,amount_minor,currency,occurred_at,detail) VALUES($1,$2,$3,'DISPUTE',$4,$5,$6,$7::jsonb)
 ON CONFLICT(source_id) DO NOTHING`,[newId('revenue'),accountId,`stripe-balance:${row.id}`,Number(row.amount),currency,at,
 JSON.stringify({balanceTransactionId:row.id,type:row.type,actual:true})]);
 if(row.fee==null){await warning(db,`stripe-fee:${row.id}`,'MISSING_STRIPE_FEE',{balanceTransactionId:row.id},accountId);return false;}
 await db.query(`INSERT INTO commercial_revenue_events
 (id,account_id,source_id,kind,amount_minor,currency,occurred_at,detail) VALUES($1,$2,$3,'FEE',$4,$5,$6,$7::jsonb)
 ON CONFLICT(source_id) DO NOTHING`,[newId('revenue'),accountId,`stripe-fee:${row.id}`,-Number(row.fee),currency,at,
 JSON.stringify({balanceTransactionId:row.id,feeDetails:row.fee_details||[],actual:true})]);
 await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED' WHERE fingerprint=$1",[`stripe-fee:${row.id}`]);return true;}
async function handle(db,event){const object=event.data?.object||{};const accountId=await owner(db,object);
 if(event.type.startsWith('charge.dispute.'))await require('./addons').receiveDispute(db,event);
 if(event.type.startsWith('refund.')){
  const handled=await require('./addons').receiveRefund(db,event);
  const knownPurchase=(await db.query('SELECT id FROM commercial_usage_purchases WHERE stripe_payment_intent_id=$1',
    [typeof object.payment_intent==='string'?object.payment_intent:object.payment_intent?.id])).rows.length>0;
  if(!handled&&accountId&&!knownPurchase)await require('./refunds').reconcile(db,event,accountId);
  if(!handled&&(!accountId||knownPurchase))await warning(db,`stripe-unattributed:${object.id}`,'UNATTRIBUTED_STRIPE_ADJUSTMENT',
   {eventId:event.id,objectId:object.id,paymentIntentId:object.payment_intent});
  else await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED' WHERE fingerprint=$1",[`stripe-unattributed:${object.id}`]);
 }
 if(!accountId){if(event.type.startsWith('charge.'))await warning(db,`stripe-unattributed:${object.id}`,
   'UNATTRIBUTED_STRIPE_ADJUSTMENT',{eventId:event.id,objectId:object.id,charge:object.charge});return false;}
 await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED' WHERE fingerprint=$1",[`stripe-unattributed:${object.id}`]);
 const balances=object.balance_transactions||[object.balance_transaction,object.failure_balance_transaction].filter(Boolean);
 for(const transaction of balances){const settled=typeof transaction==='object'
   ?await balance(db,accountId,transaction,event.type.startsWith('charge.dispute.')?'DISPUTE':'FEE'):false;
  if(!settled){const transactionId=typeof transaction==='object'?transaction.id:transaction;
   if(!transactionId)continue;
   await warning(db,`stripe-fee:${transactionId}`,'MISSING_STRIPE_FEE',{balanceTransactionId:transactionId},accountId);
   const durable=typeof db.transaction==='function'?db:{query:db.query.bind(db),transaction:fn=>fn(db)};
   await jobs.enqueue(durable,{kind:'commercial.stripe-financial-sync',idempotencyKey:`stripe-balance:${transactionId}`,
    payload:{accountId,balanceTransactionId:transactionId,paymentIntentId:typeof object.payment_intent==='string'?object.payment_intent:object.payment_intent?.id,
      kind:event.type.startsWith('charge.dispute.')?'DISPUTE':'FEE'},maxAttempts:8});}
  else if(object.payment_intent){const intent=typeof object.payment_intent==='string'?object.payment_intent:object.payment_intent.id;
    await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED' WHERE fingerprint=$1",[`stripe-payment-fee:${intent}`]);}}
 if(event.type.startsWith('charge.dispute.')&&!balances.length)await warning(db,`stripe-dispute:${object.id}`,
  'MISSING_DISPUTE_BALANCE',{eventId:event.id,disputeId:object.id},accountId);
 return true;}
async function reconcileForPayment(db,intent){const events=(await db.query(`SELECT payload FROM commercial_billing_events
 WHERE event_type IN ('refund.created','refund.updated','refund.failed','charge.succeeded','charge.updated',
   'charge.dispute.created','charge.dispute.updated','charge.dispute.closed')
 AND payload->'data'->'object'->>'payment_intent'=$1 ORDER BY (payload->>'created')::bigint,provider_event_id`,[intent])).rows;
 for(const event of events)await handle(db,event.payload);}
async function sync(db,job,options={}){const row=await (options.provider||stripe).retrieveBalanceTransaction(job.payload.balanceTransactionId,options.providerOptions||{});
 if(!await balance(db,job.payload.accountId,row,job.payload.kind))throw Object.assign(new Error('Stripe balance transaction fees are not settled yet.'),{retryable:true});
 if(job.payload.paymentIntentId)await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED' WHERE fingerprint=$1",[`stripe-payment-fee:${job.payload.paymentIntentId}`]);
 return {balanceTransactionId:row.id,reconciled:true};}
async function syncInvoice(db,job,options={}){
 const provider=options.provider||stripe;const api=options.providerOptions||{};
 const invoice=await provider.retrieveInvoice(job.payload.invoiceId,api);
 const subscription=(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[job.payload.accountId])).rows[0];
 const id=value=>typeof value==='string'?value:value?.id;
 if(invoice.id!==job.payload.invoiceId||id(invoice.customer)!==subscription?.stripe_customer_id||
   id(invoice.subscription||invoice.parent?.subscription_details?.subscription)!==subscription?.stripe_subscription_id)
  throw Error('Stripe invoice reconciliation ownership mismatch');
 const payments=await provider.listInvoicePayments(invoice.id,api);const intents=[];let cash=0;let complete=invoice.status==='paid';
 for(const payment of payments){if(payment.status!=='paid')continue;
  if(id(payment.invoice)!==invoice.id||payment.currency!==invoice.currency)throw Error('Stripe invoice payment scope mismatch');
  if(payment.payment?.type!=='payment_intent'){complete=false;continue;}
  const intent=await provider.retrievePaymentIntent(id(payment.payment.payment_intent),api);
  if(intent.status!=='succeeded'||id(intent.customer)!==subscription.stripe_customer_id||intent.currency!==invoice.currency||
    !Number.isSafeInteger(payment.amount_paid)||payment.amount_paid<0||payment.amount_paid>Number(intent.amount_received))
   throw Error('Stripe invoice payment is not verified customer cash');
  cash+=payment.amount_paid;intents.push(intent);
 }
 const settlement=require('./invoice-cash').settlement(invoice,cash);
 complete=complete&&settlement.verified;
 await db.transaction(async client=>{
  if(!complete){await warning(client,`invoice-payments:${invoice.id}`,'UNVERIFIED_STRIPE_INVOICE_CASH',
   {invoiceId:invoice.id,...settlement,amountPaid:invoice.amount_paid,total:invoice.total},job.payload.accountId);return;}
  const receipt=(await client.query('SELECT * FROM commercial_revenue_events WHERE source_id=$1 AND account_id=$2 FOR UPDATE',
    [`invoice:${invoice.id}`,job.payload.accountId])).rows[0];
  if(!receipt)throw Error('Stripe invoice reconciliation needs its signed invoice receipt first.');
  if(Number(receipt.amount_minor)!==settlement.netCashRevenueMinor)throw Error('Signed invoice receipt differs from verified net cash revenue.');
  await client.query(`UPDATE commercial_revenue_events SET detail=detail||$2::jsonb WHERE source_id=$1 AND account_id=$3`,
   [`invoice:${invoice.id}`,JSON.stringify({paymentIntentIds:[...new Set(intents.map(x=>x.id))],stripeCashVerified:true,
     paidPaymentIds:payments.filter(x=>x.status==='paid').map(x=>x.id),...settlement}),job.payload.accountId]);
  await client.query("UPDATE commercial_critical_warnings SET status='RESOLVED' WHERE fingerprint=$1",[`invoice-payments:${invoice.id}`]);
  for(const intent of intents){await reconcileForPayment(client,intent.id);
   const charge=intent.latest_charge;
   if(charge&&typeof charge==='object')await handle(client,{id:`reconcile:${invoice.id}:${charge.id}`,type:'charge.updated',
    created:Math.floor(Date.now()/1000),data:{object:charge}});
  }
 },{isolation:'SERIALIZABLE',retrySafe:true});
 return {invoiceId:invoice.id,verified:complete,cashMinor:cash,payments:payments.length};
}
module.exports={handle,reconcileForPayment,sync,syncInvoice,balance};
