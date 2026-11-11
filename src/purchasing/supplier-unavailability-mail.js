'use strict';

const {ValidationError}=require('../domain/errors');
const {randomBytes}=require('node:crypto');
const {newId}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const policy=require('../commercial/agent-plan');
const parser=require('./supplier-unavailability-mail-parser');
const {original}=require('./po-amendment-email');
const notices='stockchief_runtime.agent_backup_supplier_notices';
const kind='mail.supplier-unavailability.v1';

async function saved(db,workspaceId,messageId){
  return (await db.query(`SELECT id,line_id,supplier_reply_id,purchase_order_id FROM ${notices}
    WHERE workspace_id=$1 AND original_email_message_id=$2 ORDER BY line_id`,[workspaceId,messageId])).rows;
}

async function openLines(db,workspaceId,orderId){
  return (await db.query(`SELECT l.id,l.line_number,l.sku_id,l.supplier_sku,p.supplier_id,s.code,i.unit_label,i.secondary_unit_label,place.name AS location_name,
    coalesce(l.destination_location_id,p.destination_location_id) AS location_id,
    (l.quantity_units-l.quantity_received_units)::text AS remaining,
    (l.secondary_quantity_ordered-coalesce(l.secondary_quantity_received,0))::text AS remaining_weight
    FROM purchase_order_lines l JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    JOIN locations place ON place.workspace_id=l.workspace_id AND place.id=coalesce(l.destination_location_id,p.destination_location_id)
    WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 AND l.quantity_units>l.quantity_received_units
      AND place.is_active=1 AND place.custody_agreement_id IS NULL ORDER BY l.line_number,l.id`,[workspaceId,orderId])).rows;
}

function affectedLines(lines,selectors){
  const picked=new Set();
  const matched=selectors.map(({key,value})=>{
    const field={sku:'code','supplier sku':'supplier_sku',line:'line_number',id:'id'}[key];
    const choices=lines.filter(line=>String(line[field]??'').toLowerCase()===value.toLowerCase());
    if(choices.length!==1||picked.has(choices[0].id))
      throw new ValidationError('Match each reported unavailable product to one distinct open line on this purchase order.');
    picked.add(choices[0].id);
    return choices[0];
  });
  return matched.sort((a,b)=>a.id.localeCompare(b.id));
}

async function record(c,workspaceId,{mail,message,order,messageId,statement,lines,actorId=null}){
  const reference=hash(['supplier-email-unavailable',mail.fingerprint,order.id]);
  const replyId=newId('supplierreply');
  const scoped={query:(sql,args)=>c.query(sql,args),transaction:operation=>operation(c)};
  await require('../commercial/storage-capacity').reserve(scoped,workspaceId,'supplier-unavailability:'+reference,
    lines.length*(Buffer.byteLength(JSON.stringify(mail))+Buffer.byteLength(statement.reason)+4096),{finished:true});
  const tokenHash=order.token_hash||randomBytes(32).toString('hex');
  if(!order.token_hash){
    // Mail already proves the exact sent PO thread. Keep the existing source
    // linkage for old orders whose supplier link expired, without issuing a URL.
    await c.query(`INSERT INTO stockchief_runtime.supplier_order_links(token_hash,workspace_id,purchase_order_id,recipient,expires_at)
      VALUES($1,$2,$3,lower($4),now()+interval '90 days')`,[tokenHash,workspaceId,order.id,message.sender]);
  }
  const reply=await c.query(`INSERT INTO stockchief_runtime.supplier_link_submissions
    (id,workspace_id,token_hash,kind,fingerprint,created_at) VALUES($1,$2,$3,'unavailable',$4,$5)
    ON CONFLICT(token_hash,fingerprint) DO NOTHING RETURNING id`,[replyId,workspaceId,tokenHash,reference,mail.receivedAt]);
  if(!reply.rowCount){
    const recorded=(await c.query(`SELECT n.id FROM ${notices} n JOIN stockchief_runtime.supplier_link_submissions r
      ON r.workspace_id=n.workspace_id AND r.id=n.supplier_reply_id WHERE n.workspace_id=$1 AND r.token_hash=$2 AND r.fingerprint=$3
      ORDER BY n.line_id`,[workspaceId,tokenHash,reference])).rows;
    if(!recorded.length)throw new ValidationError('Review the saved supplier email before recording availability.');
    return {noticeIds:recorded.map(n=>n.id),purchaseOrderId:order.id,replayed:true};
  }
  const noticeIds=[];
  for(const line of lines){
    const id=newId('backup_notice');
    await c.query(`INSERT INTO ${notices}(id,workspace_id,sku_id,location_id,supplier_id,purchase_order_id,line_id,
      supplier_reply_id,evidence,source_fingerprint,valid_through,reference_quantity,secondary_quantity,reported_at,
      original_email_message_id,email_source,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [id,workspaceId,line.sku_id,line.location_id,line.supplier_id,order.id,line.id,replyId,statement.reason,
      hash([reference,line.id]),statement.validThrough,line.remaining,Number(line.remaining_weight)>0?line.remaining_weight:null,
      mail.receivedAt,messageId,JSON.stringify(mail),actorId]);
    noticeIds.push(id);
  }
  await c.query(`UPDATE connection_email_messages SET native_review_state='RECORDED',native_review_reason=$3
    WHERE workspace_id=$1 AND id=$2 AND native_review_goal_id IS NULL`,[workspaceId,messageId,'Supplier availability recorded on the original purchase order.']);
  return {noticeIds,purchaseOrderId:order.id,replayed:false};
}

async function intake(db,workspaceId,{messageId,mailboxAccount}){
  return db.transaction(async c=>{
    await policy.requireWorkspaceJob(c,workspaceId,32,'automatic');
    const previous=await saved(c,workspaceId,messageId);
    if(previous.length)return {noticeIds:previous.map(n=>n.id),purchaseOrderId:previous[0].purchase_order_id,replayed:true};
    const restriction=await require('../autopilot/job-modes').restriction(c,workspaceId,32,true);
    if(restriction)throw new ValidationError(restriction);
    const {mail,message,order}=await original(c,workspaceId,messageId,{lock:true,orderSubject:parser.subject,requireLink:false});
    if(!mailboxAccount||mail.providerAccountId!==mailboxAccount)
      throw new ValidationError('The mailbox account changed after this supplier message arrived. Review the original email.');
    if(new Date(mail.receivedAt)>new Date())throw new ValidationError('Review the supplier message receipt time before marking goods unavailable.');
    if(!['ORDERED','PARTIALLY_RECEIVED'].includes(order.status)||new Date(order.updated_at)>new Date(mail.receivedAt))
      throw new ValidationError('The order changed after the supplier’s email. Review the current quantities before marking goods unavailable.');
    const statement=parser.parse(message.subject,message.body_text);
    const today=await require('../lib/business-time').today(c,workspaceId);
    if(statement.validThrough<today)
      throw new ValidationError('The supplier’s availability statement is out of date. Check the current delivery before relying on it.');
    const lines=affectedLines(await openLines(c,workspaceId,order.id),statement.rows);
    return record(c,workspaceId,{mail,message,order,messageId,statement,lines});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function owner(db,ctx){
  await require('./supplier-email-terms-source').owner(db,ctx);
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
  await policy.requireWorkspaceJob(db,ctx.workspaceId,32,'draft');
}

async function reviewSource(db,workspaceId,messageId,{lock=false}={}){
  const linked=(await db.query(`SELECT DISTINCT p.id,p.po_number FROM connection_email_messages m
    JOIN supplier_communications sent ON sent.workspace_id=m.workspace_id AND sent.supplier_id=m.supplier_id
      AND sent.connector_id=m.connector_id AND sent.external_thread_id=m.external_thread_id AND lower(sent.recipient)=lower(m.sender)
    JOIN purchase_orders p ON p.workspace_id=sent.workspace_id AND p.id=sent.purchase_order_id
    WHERE m.workspace_id=$1 AND m.id=$2 AND m.trust_status='TRUSTED' AND m.classification='supplier'
      AND sent.message_kind='purchase_order' AND sent.status='SENT' AND sent.external_message_id IS NOT NULL
      AND sent.sent_at::timestamptz<=m.received_at::timestamptz LIMIT 2`,[workspaceId,messageId])).rows;
  if(linked.length!==1)throw new ValidationError('Choose the supplier’s original reply on the mailbox thread of one purchase order.');
  const data=await original(db,workspaceId,messageId,{lock,orderSubject:()=>linked[0].po_number,allowAttachments:true,requireLink:false});
  if(data.order.id!==linked[0].id||!['ORDERED','PARTIALLY_RECEIVED'].includes(data.order.status)||new Date(data.mail.receivedAt)>new Date())
    throw new ValidationError('Choose an original reply for a placed warehouse purchase with outstanding goods.');
  const lines=await openLines(db,workspaceId,data.order.id);
  if(!lines.length)throw new ValidationError('There are no outstanding warehouse lines on this purchase.');
  const fingerprint=hash({orderId:data.order.id,mail:data.mail,version:data.order.updated_at,lines});
  return {...data,lines,fingerprint};
}

async function review(db,ctx,messageId){
  await owner(db,ctx);
  const previous=await saved(db,ctx.workspaceId,messageId);
  if(previous.length)return {purchaseOrderId:previous[0].purchase_order_id,replayed:true};
  return reviewSource(db,ctx.workspaceId,messageId);
}

async function recordReviewed(db,ctx,messageId,input){
  return db.transaction(async c=>{
    await owner(c,ctx);
    const previous=await saved(c,ctx.workspaceId,messageId);
    if(previous.length)return {purchaseOrderId:previous[0].purchase_order_id,replayed:true};
    const data=await reviewSource(c,ctx.workspaceId,messageId,{lock:true});
    if(input.confirmed!=='yes'||input.fingerprint!==data.fingerprint)
      throw new ValidationError('Reload the original email and confirm the exact current purchase lines.');
    const normalize=value=>String(value||'').trim().replace(/\s+/g,' ');
    const reason=normalize(input.quote),body=normalize(require('../connections/reply-triage').prose(data.message.body_text));
    if(reason.length<4||reason.length>1000||!body.includes(reason))
      throw new ValidationError('Use the exact supplier statement from the current email body, excluding quoted thread history.');
    const validThrough=String(input.validThrough||''),today=await require('../lib/business-time').today(c,ctx.workspaceId);
    if(!parser.validDate(validThrough)||validThrough<today)
      throw new ValidationError('Enter the next day you will recheck this supplier statement.');
    const selectors=[].concat(input.lineIds||[]).map(id=>({key:'id',value:String(id)}));
    if(!selectors.length||selectors.length>250)throw new ValidationError('Select one to 250 exact affected purchase lines.');
    const lines=affectedLines(data.lines,selectors);
    return record(c,ctx.workspaceId,{...data,messageId,statement:{reason,validThrough},lines,actorId:ctx.actorId});
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

module.exports={kind,saved,intake,onArrival,review,recordReviewed};
