'use strict';
const {ValidationError}=require('../domain/errors'),{newId}=require('../lib/util'),policy=require('../commercial/agent-plan'),ent=require('../commercial/entitlements'),sha=v=>require('node:crypto').createHash('sha256').update(v).digest('hex');
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)}),key=row=>'supplier-invoice-upload:'+row.id+':'+row.content_hash;
async function receipt(db,workspaceId,usageKey,{renew=false}={}){
 const scope=await ent.ownerScopeForWorkspace(db,workspaceId),prior=(await db.query("SELECT status FROM commercial_usage_events WHERE account_id=$1 AND workspace_id=$2 AND meter='agent_documents' AND idempotency_key=$3 FOR UPDATE",[scope.accountId,workspaceId,usageKey])).rows[0];
 if(prior?.status==='COMMITTED')return {scope,usage:{meter:'agent_documents',units:1,idempotencyKey:usageKey},committed:true};
 const usage={meter:'agent_documents',units:1,idempotencyKey:usageKey,retryReversed:true};
 // Refresh an unread reservation under current plan/add-on funding. This closes
 // queued downgrades and expired purchased-document grants without charging twice.
 if(renew&&prior?.status==='RESERVED')await ent.reverseUsage(db,scope,{...usage,reason:'Recheck current document funding before reading'});
 await ent.reserveUsage(db,scope,usage);return {scope,usage,committed:false};
}
async function enqueue(database,ctx,{buffer,filename,purchaseOrderId}){
 if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>20*1024*1024||typeof filename!=='string'||!filename.trim()||filename.length>240)
  throw new ValidationError('Choose a complete supplier invoice file up to 20 MB.');
 return database.transaction(db=>enqueueOriginal(db,ctx,{buffer,filename:filename.trim(),purchaseOrderId,contentHash:sha(buffer),bytes:buffer.length}),
  {isolation:'SERIALIZABLE',retrySafe:true});
}
async function enqueueOriginal(db,ctx,{buffer=null,sourceId=null,filename,purchaseOrderId,contentHash,bytes}){
 await require('./agent-supplier-invoice-intake').owner(db,ctx,{lock:true});
 await policy.requireWorkspaceJob(db,ctx.workspaceId,98,'draft');
 const order=(await db.query(`SELECT p.id,p.supplier_id FROM purchase_orders p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
  WHERE p.workspace_id=$1 AND p.id=$2 AND s.status='active' AND (p.status IN('ORDERED','PARTIALLY_RECEIVED','RECEIVED') OR
  ($3::boolean AND p.status='APPROVED') OR p.status='CANCELLED' AND EXISTS(SELECT 1 FROM purchase_order_receipts r JOIN purchase_order_receipt_lines l
   ON l.workspace_id=r.workspace_id AND l.receipt_id=r.id WHERE r.workspace_id=p.workspace_id AND r.purchase_order_id=p.id AND l.quantity_units>0))
  FOR SHARE OF p,s`,[ctx.workspaceId,purchaseOrderId,Boolean(sourceId)])).rows[0];
 if(!order)throw new ValidationError('Select the exact placed purchase order and confirmed supplier for this original.');
 const prior=(await db.query('SELECT id,purchase_order_id FROM stockchief_runtime.agent_supplier_invoice_uploads WHERE workspace_id=$1 AND content_hash=$2',
  [ctx.workspaceId,contentHash])).rows[0];
 if(prior){
  if(sourceId&&prior.purchase_order_id!==purchaseOrderId)throw new ValidationError('This exact invoice is already recorded against another purchase. Review the original before matching again.');
  return {uploadId:prior.id,replayed:true};
 }
 const id=newId('supplier-invoice-upload'),row={id,content_hash:contentHash};
 await receipt(db,ctx.workspaceId,key(row));
 await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'supplier-invoice-upload:'+id,(sourceId?0:bytes*2)+8*1024*1024,{finished:true});
 await db.query(`INSERT INTO stockchief_runtime.agent_supplier_invoice_uploads(id,workspace_id,owner_id,supplier_id,purchase_order_id,filename,content,content_hash,supplier_submission_id)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,ctx.workspaceId,ctx.actorId,order.supplier_id,purchaseOrderId,filename,buffer,contentHash,sourceId]);
 await require('../operations/postgres-job-queue').enqueue(scoped(db),{workspaceId:ctx.workspaceId,kind:'import.read-supplier-invoice.v1',payload:{uploadId:id},idempotencyKey:id,priority:55,maxAttempts:8});
 return {uploadId:id};
}

async function sourceContent(db,workspaceId,row){
 if(!row.supplier_submission_id)return row.content;
 let original;
 try{original=await require('./supplier-portal-invoices').original(db,workspaceId,row.supplier_submission_id);}
 catch(error){
  if(error.code!=='not_found')throw error;
  throw new ValidationError('The linked supplier invoice or its active supplier is unavailable. Review the preserved original before continuing.');
 }
 if(original.supplier_id!==row.supplier_id||original.purchase_order_id!==row.purchase_order_id)
  throw new ValidationError('The original supplier invoice must stay on its signed purchase order.');
 return original.contents;
}
async function read(database,workspaceId,uploadId,{reader=require('./supplier-invoice-reader').read}={}){
 const account=(await database.query('SELECT owner_account_id FROM workspaces WHERE id=$1',[workspaceId])).rows[0]?.owner_account_id;if(!account)return {skipped:'inventory_missing'};
 const result=await database.withSessionLock('supplier-invoice-document-reader:'+account,async()=>database.transaction(async db=>{
  const row=(await db.query('SELECT * FROM stockchief_runtime.agent_supplier_invoice_uploads WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,uploadId])).rows[0];if(!row)return {skipped:'source_missing'};const ctx={workspaceId,actorId:row.owner_id};await require('./agent-supplier-invoice-intake').owner(db,ctx,{lock:true});await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[workspaceId]);await policy.requireWorkspaceJob(db,workspaceId,98,'draft');
  if(row.status==='STOPPED')return {stopped:true};if(row.status==='READABLE')return {readable:true,replayed:true};
  let funded;await db.query('SAVEPOINT supplier_invoice_read');try{const content=await sourceContent(db,workspaceId,row);if(!Buffer.isBuffer(content)||sha(content)!==row.content_hash)throw new ValidationError('The saved supplier invoice failed its original-file integrity check.');funded=await receipt(db,workspaceId,key(row),{renew:true});const text=await reader({filename:row.filename,buffer:content});if(!text||text.length>2000000)throw new ValidationError('The source could not be read completely.');await ent.commitUsage(db,funded.scope,funded.usage);await db.query("UPDATE stockchief_runtime.agent_supplier_invoice_uploads SET extracted_text=$3,status='READABLE',problem=NULL WHERE workspace_id=$1 AND id=$2",[workspaceId,uploadId,text]);await require('../operations/postgres-job-queue').enqueue(scoped(db),{workspaceId,kind:'agent.supplier-invoice-source',payload:{uploadId},idempotencyKey:'owner-upload:'+uploadId,priority:60,maxAttempts:8});await db.query('RELEASE SAVEPOINT supplier_invoice_read');return {readable:true,documentUnits:1};}
  catch(error){if(!['validation_error','entitlement_required'].includes(error.code))throw error;await db.query('ROLLBACK TO SAVEPOINT supplier_invoice_read');await db.query('RELEASE SAVEPOINT supplier_invoice_read');const scope=await ent.ownerScopeForWorkspace(db,workspaceId);const pending=(await db.query("SELECT status FROM commercial_usage_events WHERE account_id=$1 AND meter='agent_documents' AND idempotency_key=$2",[scope.accountId,key(row)])).rows[0];if(pending?.status==='RESERVED')await ent.reverseUsage(db,scope,{meter:'agent_documents',idempotencyKey:key(row),reason:error.message});await db.query("UPDATE stockchief_runtime.agent_supplier_invoice_uploads SET status='HELD',problem=$3 WHERE workspace_id=$1 AND id=$2",[workspaceId,uploadId,error.message.replace(/contract/gi,'invoice source')]);return {held:true,reason:error.message};}
 },{isolation:'SERIALIZABLE',retrySafe:true}));
 if(result.busy)throw Object.assign(new Error('Another invoice original is being read for this account. This source remains safely queued.'),{retryable:true});return result;
}
async function retry(database,ctx,id){return database.transaction(async db=>{await require('./agent-supplier-invoice-intake').owner(db,ctx,{lock:true});await policy.requireWorkspaceJob(db,ctx.workspaceId,98,'draft');const row=(await db.query('SELECT status FROM stockchief_runtime.agent_supplier_invoice_uploads WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.workspaceId,id])).rows[0];if(!row||row.status==='STOPPED')throw new ValidationError('That original upload is unavailable or individually stopped.');return require('../operations/postgres-job-queue').enqueue(scoped(db),{workspaceId:ctx.workspaceId,kind:row.status==='READABLE'?'agent.supplier-invoice-source':'import.read-supplier-invoice.v1',payload:{uploadId:id},idempotencyKey:'owner-retry:'+id+':'+newId('retry'),priority:55,maxAttempts:8});},{isolation:'SERIALIZABLE',retrySafe:true});}
async function cancel(database,ctx,id){return database.transaction(async db=>{await require('./agent-supplier-invoice-intake').owner(db,ctx,{lock:true});const row=(await db.query('SELECT * FROM stockchief_runtime.agent_supplier_invoice_uploads WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];if(!row)throw new ValidationError('That original upload is unavailable.');if(row.status==='READABLE')throw new ValidationError('Stop the exact invoice source review; an already-read document receipt is preserved.');const scope=await ent.ownerScopeForWorkspace(db,ctx.workspaceId),usage=(await db.query("SELECT status FROM commercial_usage_events WHERE account_id=$1 AND meter='agent_documents' AND idempotency_key=$2",[scope.accountId,key(row)])).rows[0];if(usage?.status==='RESERVED')await ent.reverseUsage(db,scope,{meter:'agent_documents',idempotencyKey:key(row),reason:'Owner stopped this unread source'});await db.query("UPDATE stockchief_runtime.agent_supplier_invoice_uploads SET status='STOPPED',problem='Stopped before reading; original retained and unused document reservation returned.' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id]);return {stopped:true};},{isolation:'SERIALIZABLE',retrySafe:true});}
module.exports={enqueue,enqueueOriginal,sourceContent,read,receipt,key,retry,cancel};
