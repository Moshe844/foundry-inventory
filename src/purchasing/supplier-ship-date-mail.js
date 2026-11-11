'use strict';

const {randomBytes}=require('node:crypto');
const {ValidationError}=require('../domain/errors');
const {newId}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const policy=require('../commercial/agent-plan');
const parser=require('./supplier-ship-date-mail-parser');
const {original}=require('./po-amendment-email');
const kind='mail.supplier-ship-date.v1';

function fingerprint(mail,orderId,shipDate){
  return hash({purpose:'supplier_ship_date',mail,orderId,shipDate});
}

async function verified(db,workspaceId,messageId,{lock=false}={}){
  const data=await original(db,workspaceId,messageId,{lock,orderSubject:parser.subject,requireLink:false,confirmationFollowUp:true});
  const {mail,message,order}=data;
  const proof={...mail,orderUpdatedAt:new Date(order.updated_at).toISOString()};
  if(!['ORDERED','PARTIALLY_RECEIVED','RECEIVED'].includes(order.status)||new Date(mail.receivedAt)>new Date())
    throw new ValidationError('Use the original supplier confirmation for the current placed warehouse purchase.');
  const {shipDate}=parser.parse(message.subject,message.body_text);
  return {...data,proof,shipDate,fingerprint:fingerprint(proof,order.id,shipDate)};
}

async function savedSource(db,workspaceId,messageId){
  return (await db.query(`SELECT r.id,l.purchase_order_id FROM stockchief_runtime.supplier_link_submissions r
    JOIN stockchief_runtime.supplier_order_links l USING(token_hash)
    WHERE r.workspace_id=$1 AND r.ship_date_email IS NOT NULL AND r.ship_date_email->>'id'=$2`,[workspaceId,messageId])).rows[0]||null;
}

async function intake(db,workspaceId,{messageId,mailboxAccount}){
  return db.transaction(async c=>{
    await policy.requireWorkspaceJob(c,workspaceId,29,'draft');
    const previous=await savedSource(c,workspaceId,messageId);
    if(previous)return {sourceId:previous.id,purchaseOrderId:previous.purchase_order_id,replayed:true};
    const data=await verified(c,workspaceId,messageId,{lock:true});
    const {mail,message,order,proof,shipDate}=data;
    if(!mailboxAccount||mail.providerAccountId!==mailboxAccount)
      throw new ValidationError('The sending mailbox account changed. Review the original supplier confirmation.');
    if(!['ORDERED','PARTIALLY_RECEIVED'].includes(order.status)||new Date(order.updated_at)>new Date(mail.receivedAt))
      throw new ValidationError('The purchase changed after this email arrived. Review the supplier’s latest confirmation.');
    const id=newId('supplierreply'),tokenHash=order.token_hash||randomBytes(32).toString('hex');
    const scoped={query:(sql,args)=>c.query(sql,args),transaction:operation=>operation(c)};
    await require('../commercial/storage-capacity').reserve(scoped,workspaceId,'supplier-ship-date-mail:'+messageId,8192,{finished:true});
    if(!order.token_hash)await c.query(`INSERT INTO stockchief_runtime.supplier_order_links(token_hash,workspace_id,purchase_order_id,recipient,expires_at)
      VALUES($1,$2,$3,lower($4),now()+interval '90 days')`,[tokenHash,workspaceId,order.id,message.sender]);
    const saved=await c.query(`INSERT INTO stockchief_runtime.supplier_link_submissions
      (id,workspace_id,token_hash,kind,ship_date,fingerprint,created_at,ship_date_email)
      VALUES($1,$2,$3,'confirm',$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
    [id,workspaceId,tokenHash,shipDate,data.fingerprint,mail.receivedAt,JSON.stringify(proof)]);
    if(!saved.rowCount)throw new ValidationError('The original confirmation is already recorded. Reload this purchase.');
    await require('./agent-supplier-ship-promises').enqueue(c,workspaceId,id);
    return {sourceId:id,purchaseOrderId:order.id,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function onArrival(db,workspaceId,payload){
  try{return await intake(db,workspaceId,payload);}
  catch(error){
    if(![400,402,403,404,422].includes(error.status))throw error;
    await db.query(`UPDATE connection_email_messages SET native_review_state='NEEDS_REVIEW',native_review_reason=$3
      WHERE workspace_id=$1 AND id=$2 AND native_review_goal_id IS NULL`,[workspaceId,payload.messageId,error.message]);
    return {held:true,reason:error.message};
  }
}

module.exports={kind,verified,savedSource,intake,onArrival};
