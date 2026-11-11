'use strict';

const {ValidationError,NotFoundError}=require('../domain/errors');
const {createHash}=require('node:crypto');
const policy=require('../commercial/agent-plan');
const uploads=require('./supplier-invoice-uploads');
const kind='import.supplier-portal-invoice.v1';

async function queue(client,workspaceId,sourceId){
  const state=await policy.accountState(client,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,98,'draft'))return;
  return require('../operations/postgres-job-queue').enqueue({query:(...args)=>client.query(...args),transaction:fn=>fn(client)},
    {workspaceId,kind,payload:{sourceId},idempotencyKey:'supplier-portal-invoice:'+sourceId,priority:55,maxAttempts:8});
}

async function original(db,workspaceId,sourceId){
  const row=(await db.query(`SELECT r.contents,r.fingerprint,r.created_at,l.expires_at,l.recipient,l.purchase_order_id,
    p.supplier_id,s.email,p.status,w.owner_account_id FROM stockchief_runtime.supplier_link_submissions r
    JOIN stockchief_runtime.supplier_order_links l ON l.workspace_id=r.workspace_id AND l.token_hash=r.token_hash
    JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
    JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id AND s.status='active'
    JOIN workspaces w ON w.id=r.workspace_id AND w.deletion_requested_at IS NULL
    WHERE r.workspace_id=$1 AND r.id=$2 AND r.kind='invoice' FOR SHARE OF r,l,p,s`,[workspaceId,sourceId])).rows[0];
  if(!row)throw new NotFoundError('That original supplier invoice is unavailable.');
  if(!Buffer.isBuffer(row.contents)||row.contents.subarray(0,5).toString()!=='%PDF-'||row.contents.length>4*1024*1024||
    row.recipient!==String(row.email||'').toLowerCase()||new Date(row.created_at)>=new Date(row.expires_at))
    throw new ValidationError('Check the original supplier invoice and the purchase it was sent for.');
  const contentHash=createHash('sha256').update(row.contents).digest('hex');
  if(row.fingerprint!==require('./supplier-order-link').responseFingerprint('invoice',contentHash))
    throw new ValidationError('The supplier invoice no longer matches its original uploaded file.');
  return {...row,contentHash};
}

async function prepare(database,workspaceId,sourceId,{actorId=null,purchaseOrderId=null}={}){
  return database.transaction(async c=>{
    await policy.requireWorkspaceJob(c,workspaceId,98,'draft');
    const source=await original(c,workspaceId,sourceId);
    if(purchaseOrderId&&source.purchase_order_id!==purchaseOrderId)throw new NotFoundError('That supplier invoice is not on this purchase.');
    const ownerId=actorId||(await c.query(`SELECT id FROM users WHERE workspace_id=$1 AND account_id=$2 AND role='owner'
      ORDER BY created_at,id LIMIT 1`,[workspaceId,source.owner_account_id])).rows[0]?.id;
    if(!ownerId)throw new ValidationError('An active inventory owner is required before this invoice can be matched.');
    return uploads.enqueueOriginal(c,{workspaceId,actorId:ownerId},{purchaseOrderId:source.purchase_order_id,
      filename:'Supplier invoice.pdf',contentHash:source.contentHash,sourceId,bytes:source.contents.length});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function work(database,workspaceId,sourceId){
  try{return await prepare(database,workspaceId,sourceId);}
  catch(error){if(![400,402,403,404,422].includes(error.status))throw error;return {held:true,reason:error.message};}
}

async function reviews(db,workspaceId,orderId){
  const {rows}=await db.query(`SELECT u.supplier_submission_id,u.id AS upload_id,u.status AS upload_status,
    q.id AS intake_id,q.status AS intake_status FROM stockchief_runtime.agent_supplier_invoice_uploads u
    LEFT JOIN stockchief_runtime.agent_supplier_invoice_intakes q ON q.workspace_id=u.workspace_id AND q.source_upload_id=u.id
    WHERE u.workspace_id=$1 AND u.purchase_order_id=$2 AND u.supplier_submission_id IS NOT NULL`,[workspaceId,orderId]);
  return new Map(rows.map(row=>[row.supplier_submission_id,row]));
}

module.exports={kind,queue,original,prepare,work,reviews};
