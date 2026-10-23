'use strict';
const crypto=require('node:crypto'),shipping=require('./postgres-service'),permissions=require('../actions/permissions'),money=require('../domain/currency'),{newId,nowIso}=require('../lib/util'),{ValidationError,NotFoundError}=require('../domain/errors');
function request(input){
 const key=String(input.idempotencyKey||'').trim();if(!key||key.length>200)throw new ValidationError('A batch needs a durable request key of up to 200 characters.');
 if(!Array.isArray(input.entries)||!input.entries.length||input.entries.length>100)throw new ValidationError('Choose 1 to 100 parcels for this batch.');
 const seen=new Set(),entries=input.entries.map(row=>{const shipmentId=String(row.shipmentId||''),rateId=String(row.rateId||'');if(!shipmentId||!rateId||shipmentId.length>200||rateId.length>200||seen.has(shipmentId))throw new ValidationError('Choose one current rate per parcel, without duplicate parcels.');seen.add(shipmentId);return {shipmentId,rateId};}).sort((a,b)=>a.shipmentId.localeCompare(b.shipmentId));
 const currency=money.code(input.currency),maxAmountMinor=money.integer(input.maxAmountMinor,'Approved postage limit');
 return {key,entries,currency,maxAmountMinor,hash:crypto.createHash('sha256').update(JSON.stringify({entries,currency,maxAmountMinor})).digest('hex')};
}
async function queue(database,ctx,input){const r=request(input);
 return database.transaction(async client=>{
  await require('./postgres-parcel-options').actor(client,ctx,permissions.ADMIN);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['shipping-batch:'+ctx.workspaceId+':'+r.key]);
  const prior=(await client.query('SELECT * FROM shipping_label_batches WHERE workspace_id=$1 AND idempotency_key=$2',[ctx.workspaceId,r.key])).rows[0];
  if(prior){if(prior.request_hash!==r.hash)throw new ValidationError('That request key belongs to a different approved batch.');return {...await detail(client,ctx.workspaceId,prior.id),replayed:true};}
  const rates=[];for(const entry of r.entries){await shipping.requireShipment(client,ctx.workspaceId,entry.shipmentId,true);const rate=(await client.query('SELECT * FROM shipment_rates WHERE workspace_id=$1 AND shipment_id=$2 AND id=$3',[ctx.workspaceId,entry.shipmentId,entry.rateId])).rows[0];if(!rate)throw new ValidationError('Choose a current rate for every parcel.');if(rate.currency!==r.currency)throw new ValidationError('A batch must use one currency. No conversion will be assumed.');rates.push(rate);}
  const totalMinor=money.sum(rates.map(rate=>money.integer(rate.amount_minor)));if(totalMinor>r.maxAmountMinor)throw new ValidationError('The quoted postage exceeds the approved batch limit. Nothing was purchased or queued.');
  const id=newId('shipbatch');await client.query('INSERT INTO shipping_label_batches(id,workspace_id,idempotency_key,request_hash,currency,approved_amount_minor,created_by_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,ctx.workspaceId,r.key,r.hash,r.currency,r.maxAmountMinor,ctx.actorId,nowIso()]);
  const joined={query:(...args)=>client.query(...args),transaction:operation=>operation(client)};
  for(const [index,entry]of r.entries.entries()){
   const purchase=await shipping.queueLabelPurchase(joined,ctx,entry.shipmentId,entry.rateId,{idempotencyKey:'batch:'+id+':'+entry.shipmentId});
   if(!purchase.queued||!purchase.transactionId)throw new ValidationError('A parcel already has a purchased label. Remove it from this new batch.');
   await client.query('INSERT INTO shipping_label_batch_items(batch_id,workspace_id,shipment_id,rate_id,transaction_id,effect_id,quoted_amount_minor) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,ctx.workspaceId,entry.shipmentId,entry.rateId,purchase.transactionId,purchase.effectId,rates[index].amount_minor]);
  }
  return {...await detail(client,ctx.workspaceId,id),replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
function references(value){try{return typeof value==='string'?JSON.parse(value):value;}catch{return null;}}
async function detail(database,workspaceId,id){
 const batch=(await database.query('SELECT * FROM shipping_label_batches WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];if(!batch)throw new NotFoundError('That label batch was not found in this business.');
 const entries=(await database.query(`SELECT item.*,shipment.shipment_number,shipment.label_status,shipment.shipping_documents,shipment.provider_packages,
 transaction.status,transaction.error_message,transaction.provider_reference,transaction.amount_minor
 FROM shipping_label_batch_items item JOIN sales_shipments shipment ON shipment.workspace_id=item.workspace_id AND shipment.id=item.shipment_id
 JOIN shipping_label_transactions transaction ON transaction.workspace_id=item.workspace_id AND transaction.id=item.transaction_id
 WHERE item.workspace_id=$1 AND item.batch_id=$2 ORDER BY shipment.shipment_number,item.shipment_id`,[workspaceId,id])).rows.map(row=>{
  const original=references(row.provider_reference),current=(row.provider_packages||[]).map(p=>p.externalId);
  const same=Array.isArray(original)&&original.length>0&&original.length===current.length&&original.every((v,i)=>v===current[i]);
  return {...row,documents:row.status==='SUCCEEDED'&&row.label_status==='PURCHASED'&&same?(row.shipping_documents||[]).filter(d=>d.kind==='LABEL'):[]};
 });
 return {...batch,entries,effectIds:entries.map(row=>row.effect_id),totalMinor:money.sum(entries.map(row=>money.integer(row.quoted_amount_minor))),complete:entries.filter(row=>row.status==='SUCCEEDED').length,needsAttention:entries.filter(row=>['REVIEW','FAILED'].includes(row.status)).length};
}
async function candidates(database,workspaceId){return (await database.query(`SELECT shipment.id,shipment.shipment_number,shipment.currency,rate.id AS rate_id,rate.provider,rate.carrier,rate.service,rate.amount_minor,rate.quoted_at
 FROM sales_shipments shipment JOIN shipment_rates rate ON rate.workspace_id=shipment.workspace_id AND rate.shipment_id=shipment.id
 WHERE shipment.workspace_id=$1 AND shipment.status IN ('PACKED','PICKING') AND coalesce(shipment.label_status,'') NOT IN ('PURCHASED','PENDING','REVIEW','VOID_PENDING')
 AND rate.quoted_at >= $2 ORDER BY shipment.shipment_number,rate.amount_minor LIMIT 1000`,[workspaceId,new Date(Date.now()-30*60_000).toISOString()])).rows;}
module.exports={queue,detail,candidates,request};
