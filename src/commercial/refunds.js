'use strict';
const {newId}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const RANK={pending:0,requires_action:0,succeeded:1,failed:2,canceled:2};

// Must run in the same transaction as the signed event and funding adjustment.
async function reconcile(client,event,accountId,purchase=null){
 const refund=event.data.object;const intent=typeof refund.payment_intent==='string'?refund.payment_intent:refund.payment_intent?.id;
 const currency=String(refund.currency||'').toUpperCase();
 if(!refund.id||!intent||!Number.isSafeInteger(refund.amount)||refund.amount<=0||!Number.isSafeInteger(event.created)||
   !/^[A-Z]{3}$/.test(currency)||!Object.hasOwn(RANK,refund.status))throw new ValidationError('Invalid Stripe refund identity, amount or status.');
 if(purchase&&(purchase.account_id!==accountId||currency!==purchase.currency||refund.amount>Number(purchase.amount_minor)))
  throw new ValidationError('Refund amount or currency does not match the usage purchase.');
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`stripe-refund:${refund.id}`]);
 const prior=(await client.query('SELECT * FROM commercial_stripe_refunds WHERE id=$1 FOR UPDATE',[refund.id])).rows[0];
 if(prior&&(prior.account_id!==accountId||prior.payment_intent_id!==intent||prior.purchase_id!==(purchase?.id||null)||
    Number(prior.amount_minor)!==refund.amount||prior.currency!==currency))throw new ValidationError('Refund identity conflicts with its recorded ownership or amount.');
 const priorAt=prior?new Date(prior.provider_created_at).getTime():0;
 // A failed/canceled refund cannot return to succeeded. A stale pending update
 // also cannot roll back a successful refund, including same-second deliveries.
 const stale=prior&&(RANK[prior.status]>RANK[refund.status]||RANK[prior.status]===2||
   (RANK[prior.status]===RANK[refund.status]&&priorAt>event.created*1000));
 const status=stale?prior.status:refund.status;
 if(!stale)await client.query(`INSERT INTO commercial_stripe_refunds
   (id,account_id,purchase_id,payment_intent_id,amount_minor,currency,status,provider_created_at,provider_event_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),$9) ON CONFLICT(id) DO UPDATE
   SET status=EXCLUDED.status,provider_created_at=EXCLUDED.provider_created_at,provider_event_id=EXCLUDED.provider_event_id,updated_at=now()`,
   [refund.id,accountId,purchase?.id||null,intent,refund.amount,currency,status,event.created,event.id]);
 const detail={refundId:refund.id,paymentIntentId:intent,actual:true,...(purchase?{purchaseId:purchase.id}:{})};
 if(status==='succeeded')await client.query(`INSERT INTO commercial_revenue_events
   (id,account_id,source_id,kind,amount_minor,currency,occurred_at,detail)
   VALUES($1,$2,$3,'REFUND',$4,$5,to_timestamp($6),$7::jsonb) ON CONFLICT(source_id) DO NOTHING`,
   [newId('revenue'),accountId,`refund:${refund.id}`,-refund.amount,currency,event.created,JSON.stringify(detail)]);
 if(['failed','canceled'].includes(status)){
  const debit=(await client.query('SELECT * FROM commercial_revenue_events WHERE source_id=$1',[`refund:${refund.id}`])).rows[0];
  if(debit){
   if(debit.account_id!==accountId||debit.currency!==currency||Number(debit.amount_minor)!==-refund.amount)
    throw new ValidationError('Refund compensation conflicts with its original ledger entry.');
   await client.query(`INSERT INTO commercial_revenue_events
     (id,account_id,source_id,kind,amount_minor,currency,occurred_at,detail)
     VALUES($1,$2,$3,'REFUND',$4,$5,to_timestamp($6),$7::jsonb) ON CONFLICT(source_id) DO NOTHING`,
     [newId('revenue'),accountId,`refund-reversal:${refund.id}`,refund.amount,currency,
       stale?Math.floor(priorAt/1000):event.created,JSON.stringify({...detail,refundReversed:true,refundStatus:status})]);
  }
 }
 return {status};
}
module.exports={reconcile};
