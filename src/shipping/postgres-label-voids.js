'use strict';
const {newId,nowIso}=require('../lib/util'),{ValidationError,InvariantError}=require('../domain/errors');
const effects=require('../operations/postgres-provider-effects'),jobs=require('../operations/postgres-job-queue'),accounts=require('./postgres-accounts'),providers=require('./provider');
const shipping=()=>require('./postgres-service');
function refs(value){try{const parsed=typeof value==='string'?JSON.parse(value):value;return Array.isArray(parsed)?parsed.filter(id=>typeof id==='string'&&id.length>0&&id.length<=500):[];}catch{return [];}}
async function queue(database,ctx,shipmentId,input={}){return database.transaction(async client=>{
 const actor=(await client.query('SELECT * FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 require('../actions/permissions').assertCan(actor,require('../actions/permissions').ADMIN,'void a shipping label');
 const shipment=await shipping().requireShipment(client,ctx.workspaceId,shipmentId,true);
 if(['SHIPPED','DELIVERED'].includes(shipment.status)||['IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','RETURNED'].includes(shipment.tracking_status))
  throw new ValidationError('This parcel already left. Use the physical return workflow instead of voiding its label.');
 const purchase=(await client.query("SELECT * FROM shipping_label_transactions WHERE workspace_id=$1 AND shipment_id=$2 AND operation='PURCHASE' AND status='SUCCEEDED' ORDER BY requested_at DESC,id DESC LIMIT 1",[ctx.workspaceId,shipmentId])).rows[0];
 if(!purchase)throw new ValidationError('There is no verified label purchase to void.');
 const key=String(input.idempotencyKey||'label-void:'+purchase.id).trim();if(!key||key.length>500)throw new ValidationError('A stable void request key is required.');
 const previous=(await client.query('SELECT * FROM shipping_label_transactions WHERE workspace_id=$1 AND idempotency_key=$2',[ctx.workspaceId,key])).rows[0];
 if(previous&&(previous.shipment_id!==shipmentId||previous.operation!=='VOID'||previous.purchase_transaction_id!==purchase.id))
  throw new ValidationError('This request belongs to a different original label purchase.');
 const active=previous||(await client.query("SELECT * FROM shipping_label_transactions WHERE workspace_id=$1 AND purchase_transaction_id=$2 AND operation='VOID' AND status IN ('PENDING','SUCCEEDED','REVIEW')",[ctx.workspaceId,purchase.id])).rows[0];
 if(active){
  const effect=(await client.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='shipping.label.void' AND payload->>'transactionId'=$2",[ctx.workspaceId,active.id])).rows[0];
  if(active.status==='FAILED')throw new ValidationError(active.error_message||'The carrier rejected this request. Review its reason before preparing a new request.');
  return {effectId:effect?.id,transactionId:active.id,purchaseTransactionId:purchase.id,status:active.status,replayed:true};
 }
 if(shipment.label_status!=='PURCHASED')throw new ValidationError('Resolve the existing label operation before requesting a void.');
 const labels=refs(purchase.provider_reference);if(!labels.length)throw new ValidationError('The original label has no retained provider identity. Verify it before voiding.');
 const original=(await client.query("SELECT payload FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='shipping.label.purchase' AND payload->>'transactionId'=$2",[ctx.workspaceId,purchase.id])).rows[0];
 if(!original?.payload?.connectorId)throw new ValidationError('The original postage account must be identified before this label can be voided.');
 const id=newId('shiptxn'),at=nowIso();
 await client.query(`INSERT INTO shipping_label_transactions(id,workspace_id,shipment_id,provider,operation,status,idempotency_key,purchase_transaction_id,refund_status,currency,requested_by_user_id,requested_at,updated_at,provider_reference)
  VALUES($1,$2,$3,$4,'VOID','PENDING',$5,$6,'PENDING',$7,$8,$9,$9,$10)`,[id,ctx.workspaceId,shipmentId,purchase.provider,key,purchase.id,purchase.currency,ctx.actorId,at,JSON.stringify(labels)]);
 const queued=await effects.enqueueInTransaction(client,{workspaceId:ctx.workspaceId,kind:'shipping.label.void',provider:purchase.provider,aggregateType:'shipment',aggregateId:shipmentId,idempotencyKey:key,requestedByUserId:ctx.actorId,
  payload:{transactionId:id,purchaseTransactionId:purchase.id,shipmentId,actorId:ctx.actorId,connectorId:original.payload.connectorId,providerReferences:labels},priority:10,maxAttempts:1});
 await client.query("UPDATE sales_shipments SET label_status='VOID_PENDING',updated_at=$3 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,shipmentId,at]);
 return {effectId:queued.effect.id,transactionId:id,purchaseTransactionId:purchase.id,status:'PENDING',replayed:false};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function enqueueVerification(client,effect){return jobs.enqueue({query:(...args)=>client.query(...args),transaction:operation=>operation(client)},
 {workspaceId:effect.workspaceId,kind:'shipping.void.verify',idempotencyKey:'shipping-void-verification:'+effect.id,payload:{effectId:effect.id},priority:12,maxAttempts:80});}
async function pending(database,effect,error,{final=false}={}){
 return effects.finishError(database,effect.workspaceId,effect.id,effect.claimToken,error,{ambiguous:true,apply:async client=>{
  const at=nowIso();await client.query(`UPDATE shipping_label_transactions SET status=$3,refund_status='PENDING',error_message=$4,updated_at=$5 WHERE workspace_id=$1 AND id=$2`,
   [effect.workspaceId,effect.payload.transactionId,final?'REVIEW':'PENDING',final?'The saved carrier void needs review. It was not submitted again.':'The carrier is processing the saved void request. StockChief is checking its status.',at]);
  await client.query("UPDATE sales_shipments SET label_status=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2",[effect.workspaceId,effect.aggregateId,final?'REVIEW':'VOID_PENDING',at]);
  if(!final)await enqueueVerification(client,effect);
 }});
}
async function settle(database,effect,result){
 if(!['SUCCEEDED','FAILED','PENDING'].includes(result?.status))throw new InvariantError('The carrier returned an unrecognized void result.','shipping_void_unverified');
 if(result.status==='PENDING')return false;
 const refundStatus=result.refundStatus||'UNKNOWN';if(!['PENDING','CONFIRMED','REJECTED','UNKNOWN'].includes(refundStatus))throw new InvariantError('The carrier refund status needs verification.','shipping_refund_unverified');
 const at=nowIso();
 if(result.status==='FAILED'){
  const error=Object.assign(new ValidationError(result.detail||'The carrier rejected the void request.'),{retryable:false});
  await effects.finishError(database,effect.workspaceId,effect.id,effect.claimToken,error,{ambiguous:false,apply:async client=>{
   await client.query("UPDATE shipping_label_transactions SET status='FAILED',refund_status='REJECTED',error_message=$3,completed_at=$4,updated_at=$4 WHERE workspace_id=$1 AND id=$2",[effect.workspaceId,effect.payload.transactionId,error.message.slice(0,500),at]);
   await client.query("UPDATE sales_shipments SET label_status='PURCHASED',updated_at=$3 WHERE workspace_id=$1 AND id=$2",[effect.workspaceId,effect.aggregateId,at]);
  }});return true;
 }
 const amount=Number.isSafeInteger(result.refundAmountMinor)&&result.refundAmountMinor>=0?result.refundAmountMinor:null;
 await effects.succeed(database,effect.workspaceId,effect.id,effect.claimToken,{providerReference:effect.providerReference,result:{voided:true,refundStatus,refundAmountMinor:amount},apply:async client=>{
  const shipment=await shipping().requireShipment(client,effect.workspaceId,effect.aggregateId,true);
  if(!['PACKED','PICKING'].includes(shipment.status))throw new InvariantError('This parcel changed during void verification.','shipping_void_conflict');
  await client.query(`UPDATE shipping_label_transactions SET status='SUCCEEDED',refund_status=$3,amount_minor=$4,detail=$5,error_message=NULL,completed_at=$6,updated_at=$6 WHERE workspace_id=$1 AND id=$2`,
   [effect.workspaceId,effect.payload.transactionId,refundStatus,amount,String(result.detail||'Carrier confirmed that the label is void.').slice(0,500),at]);
  await client.query("UPDATE sales_shipments SET label_status='VOIDED',label_voided_at=$3,postage_refund_minor=$4,updated_at=$3 WHERE workspace_id=$1 AND id=$2",[effect.workspaceId,effect.aggregateId,at,amount]);
 }});return true;
}
async function callProvider(database,effect,options,method){
 const held=await accounts.contextFor(database,{workspaceId:effect.workspaceId,actorId:effect.payload.actorId},{connectorId:effect.payload.connectorId,provider:effect.provider});
 if(!held)throw Object.assign(new ValidationError('Reconnect the original postage account to verify or void its saved label.'),{retryable:false});
 const provider=options.provider||providers.get(effect.provider);if(typeof provider[method]!=='function')throw Object.assign(new ValidationError('This provider cannot verify this operation through its API. Review the existing carrier record.'),{retryable:false});
 const scope=await require('../commercial/entitlements').ownerScopeForWorkspace(database,effect.workspaceId);
 try{return await require('../commercial/context').run({database,scope,system:true,requestId:'shipping-void:'+effect.id},()=>provider[method](held.ctx,
  {providerReferences:effect.payload.providerReferences,idempotencyKey:effect.idempotencyKey}));}
 catch(error){error.message=String(error.message||'The carrier operation could not be verified.').replaceAll(held.account.apiKey,'[redacted]')
   .replaceAll(Buffer.from(held.account.apiKey+':').toString('base64'),'[redacted]').slice(0,500);throw error;}
}
async function execute(database,workspaceId,effectId,options={}){
 const claimed=await effects.claim(database,workspaceId,effectId);if(claimed.replayed)return {replayed:true,status:'SUCCEEDED'};
 const effect=claimed.effect;if(effect.kind!=='shipping.label.void')throw new ValidationError('That operation is not a label void.');
 await effects.checkpoint(database,workspaceId,effect.id,effect.claimToken,{externalId:effect.payload.providerReferences[0],labelIds:effect.payload.providerReferences});
 effect.providerReference={externalId:effect.payload.providerReferences[0],labelIds:effect.payload.providerReferences};
 try{const result=await callProvider(database,effect,options,'voidLabel');if(await settle(database,effect,result))return {status:result.status,replayed:false};
  await pending(database,effect,Object.assign(new Error('Carrier void confirmation pending.'),{providerOutcomeUncertain:true}));return {status:'PENDING',replayed:false};
 }catch(error){if(effects.definiteFailure(error)){
   await settle(database,effect,{status:'FAILED',refundStatus:'REJECTED',detail:error.message});return {status:'FAILED',replayed:false};
  }await pending(database,effect,error);return {status:'PENDING',replayed:false};}
}
async function verify(database,workspaceId,effectId,options={}){
 const claimed=await effects.claimVerification(database,workspaceId,effectId,'shipping.label.void');if(claimed.replayed)return {status:'SUCCEEDED',replayed:true};
 const effect=claimed.effect;let result;
 try{result=await callProvider(database,effect,options,'verifyVoid');if(await settle(database,effect,result))return {status:result.status,replayed:false};}
 catch(error){const final=options.finalAttempt||error.retryable===false||effects.definiteFailure(error);await pending(database,effect,error,{final});throw Object.assign(new ValidationError('The saved carrier void needs verification; it was not submitted again.'),{retryable:!final,retryAfterMs:60000});}
 const error=Object.assign(new Error('The carrier is still processing the existing void.'),{providerOutcomeUncertain:true});
 await pending(database,effect,error,{final:options.finalAttempt});throw Object.assign(error,{retryable:!options.finalAttempt,retryAfterMs:result.retryAfterMs||60000});
}
async function recover(client,options={}){
 const rows=(await client.query("SELECT * FROM stockchief_runtime.provider_effects WHERE kind='shipping.label.void' AND status='AMBIGUOUS' AND provider_reference->>'externalId' IS NOT NULL ORDER BY updated_at,id LIMIT 100 FOR UPDATE SKIP LOCKED")).rows;
 for(const row of rows){const provider=options.providerResolver?options.providerResolver(row.provider):providers.get(row.provider);if(typeof provider.verifyVoid!=='function')continue;
  const effect=effects.hydrate(row),queued=await enqueueVerification(client,effect);if(['PENDING','RUNNING','RETRY'].includes(queued.job.status)){
   await client.query("UPDATE sales_shipments SET label_status='VOID_PENDING' WHERE workspace_id=$1 AND id=$2 AND label_status='REVIEW'",[effect.workspaceId,effect.aggregateId]);
   await client.query("UPDATE shipping_label_transactions SET status='PENDING' WHERE workspace_id=$1 AND id=$2 AND status='REVIEW'",[effect.workspaceId,effect.payload.transactionId]);
  }
 }return {checked:rows.length};
}
module.exports={queue,execute,verify,recover};
