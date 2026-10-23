'use strict';

// Acknowledges an already-reported charge. This never buys postage, changes the
// original quote or approval, or invents a provider identity or receipt.
const crypto=require('node:crypto');
const {ValidationError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const permissions=require('../actions/permissions');

function fingerprint(transactionId,reference,amountMinor,currency){
 // The durable effect stores an identity object while pending and its exact
 // provider-label array after success. Keep one identity across that transition.
 const ids=Array.isArray(reference)?reference:reference?.externalIds||[reference?.externalId],count=reference?.expectedCount||ids.length;
 return crypto.createHash('sha256').update(JSON.stringify([transactionId,ids,count,amountMinor,currency])).digest('hex');
}
async function view(database,workspaceId,shipmentId){
 const row=(await database.query(`SELECT transaction.id,transaction.status,transaction.amount_minor,transaction.currency,
   transaction.approved_amount_minor, effect.id AS effect_id,effect.status AS effect_status,effect.provider_reference,
   effect.error_code,effect.payload,shipment.status AS shipment_status,shipment.label_status,
   rate.currency AS quoted_currency,rate.amount_minor AS quoted_minor
  FROM shipping_label_transactions transaction
  JOIN sales_shipments shipment ON shipment.workspace_id=transaction.workspace_id AND shipment.id=transaction.shipment_id
  JOIN stockchief_runtime.provider_effects effect ON effect.workspace_id=transaction.workspace_id
   AND effect.kind='shipping.label.purchase' AND effect.payload->>'transactionId'=transaction.id
  LEFT JOIN shipment_rates rate ON rate.workspace_id=transaction.workspace_id AND rate.id=effect.payload->>'rateId'
  WHERE transaction.workspace_id=$1 AND transaction.shipment_id=$2 AND transaction.operation='PURCHASE'
  ORDER BY transaction.requested_at DESC,transaction.id DESC LIMIT 1`,[workspaceId,shipmentId])).rows[0];
 if(!row)return null;
 const amountMinor=row.amount_minor==null?null:Number(row.amount_minor),known=Number.isSafeInteger(amountMinor)&&amountMinor>=0;
 return {transactionId:row.id,effectId:row.effect_id,amountMinor,currency:row.currency,
  quotedMinor:!row.quoted_currency?null:row.approved_amount_minor==null?row.quoted_minor==null?null:Number(row.quoted_minor):Number(row.approved_amount_minor),
  quotedCurrency:row.quoted_currency,status:row.status,
  fingerprint:fingerprint(row.id,row.provider_reference,amountMinor,row.currency),
  acceptable:known&&row.currency===row.quoted_currency&&row.error_code==='shipping_charge_exceeds_approval'
   &&row.status==='REVIEW'&&row.effect_status==='AMBIGUOUS'&&Boolean(row.provider_reference?.externalId)
   &&['PACKED','PICKING'].includes(row.shipment_status)&&row.label_status==='REVIEW'};
}
async function accept(database,ctx,shipmentId,input){
 return database.transaction(async client=>{
  await require('./postgres-parcel-options').actor(client,ctx,permissions.ADMIN);
  const initial=await view(client,ctx.workspaceId,shipmentId);
  if(!initial)throw new ValidationError('That saved carrier receipt was not found in this business.');
  await client.query('SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,initial.effectId]);
  await client.query('SELECT id FROM shipping_label_transactions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,initial.transactionId]);
  await require('./postgres-service').requireShipment(client,ctx.workspaceId,shipmentId,true);
  const current=await view(client,ctx.workspaceId,shipmentId);
  if(!current||input.fingerprint!==current.fingerprint||input.amountMinor!==current.amountMinor||input.currency!==current.currency)
   throw new ValidationError('The carrier receipt changed. Review its exact current amount and currency again.');
  const previous=(await client.query('SELECT id,job_id FROM shipping_receipt_reviews WHERE workspace_id=$1 AND effect_id=$2 AND fingerprint=$3',[ctx.workspaceId,current.effectId,current.fingerprint])).rows[0];
  if(previous)return {effectId:current.effectId,transactionId:current.transactionId,reviewId:previous.id,jobId:previous.job_id,replayed:true};
  if(!current.acceptable)throw new ValidationError('This receipt cannot be accepted here. The original carrier identity, currency and verified charge must be available, with the parcel still unshipped.');
  const id=newId('shipreview'),at=nowIso(),job=await require('../operations/postgres-job-queue').enqueue({query:(...args)=>client.query(...args),transaction:operation=>operation(client)},
   {workspaceId:ctx.workspaceId,kind:'shipping.label.verify',idempotencyKey:'shipping-receipt-review:'+id,
    payload:{effectId:current.effectId,readOnlyVerification:true},priority:10,maxAttempts:12});
  await client.query(`INSERT INTO shipping_receipt_reviews(id,workspace_id,shipment_id,transaction_id,effect_id,job_id,fingerprint,amount_minor,currency,actor_user_id,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,ctx.workspaceId,shipmentId,current.transactionId,current.effectId,job.job.id,current.fingerprint,current.amountMinor,current.currency,ctx.actorId,at]);
  await client.query("UPDATE shipping_label_transactions SET status='PENDING',detail='Owner acknowledged the exact reported charge; verifying the existing carrier receipt.',updated_at=$3 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,current.transactionId,at]);
  await client.query("UPDATE sales_shipments SET label_status='PENDING',updated_at=$3 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,shipmentId,at]);
  return {effectId:current.effectId,transactionId:current.transactionId,reviewId:id,jobId:job.job.id,replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function covers(database,workspaceId,effect,bought){
 const input=effect.payload,hash=fingerprint(input.transactionId,effect.providerReference,bought.amountMinor,bought.currency);
 return Boolean((await database.query(`SELECT 1 FROM shipping_receipt_reviews WHERE workspace_id=$1 AND effect_id=$2
  AND transaction_id=$3 AND shipment_id=$4 AND fingerprint=$5 AND amount_minor=$6 AND currency=$7`,
 [workspaceId,effect.id,input.transactionId,input.shipmentId,hash,bought.amountMinor,bought.currency])).rows.length);
}
module.exports={view,accept,covers};
