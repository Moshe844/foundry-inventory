'use strict';

const {ValidationError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions');
const {newId}=require('../lib/util');
const policy=require('../commercial/agent-plan');
const parser=require('./po-amendment-email-parser');
const source=require('./po-delivery-date-source');
const {tokenFingerprint}=require('./po-amendment-link');

const kind='mail.supplier-po-amendment.v1';
const same=(a,b)=>String(a||'').trim().toLowerCase()===String(b||'').trim().toLowerCase();

async function original(db,workspaceId,id,{lock=false,orderSubject=parser.subject,allowAttachments=false,requireLink=true}={}){
  const message=(await db.query(`SELECT m.id,m.connector_id,m.sender,m.subject,m.body_text,m.received_at,
    m.content_hash,m.external_thread_id,m.supplier_id,c.provider_type,c.provider_account_id,
    EXISTS(SELECT 1 FROM connection_email_attachments a WHERE a.workspace_id=m.workspace_id AND a.message_id=m.id) AS has_attachments
    FROM connection_email_messages m JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id
    JOIN suppliers s ON s.workspace_id=m.workspace_id AND s.id=m.supplier_id AND s.status='active' AND lower(s.email)=lower(m.sender)
    WHERE m.workspace_id=$1 AND m.id=$2 AND m.trust_status='TRUSTED' AND m.classification='supplier'
      AND c.status='connected' AND c.paused_at IS NULL AND c.provider_type IN ('gmail','microsoft365')
      AND c.provider_account_id IS NOT NULL AND c.setup_status IS DISTINCT FROM 'REAUTHORIZATION_REQUIRED'`,[workspaceId,id])).rows[0];
  if(!message||!message.external_thread_id||message.has_attachments&&!allowAttachments)
    throw new ValidationError('Use the original email from the known supplier on this purchase order’s connected mailbox thread.');
  const requestedOrder=orderSubject(message.subject);
  const orders=(await db.query(`SELECT p.id,p.po_number,p.currency,p.status,p.updated_at,l.token_hash
    FROM purchase_orders p ${requireLink?'JOIN':'LEFT JOIN'} LATERAL (
      SELECT token_hash FROM stockchief_runtime.supplier_order_links
      WHERE workspace_id=p.workspace_id AND purchase_order_id=p.id AND recipient=lower($4) AND expires_at>now()
      ORDER BY expires_at DESC,token_hash LIMIT 1
    ) l ON true
    WHERE p.workspace_id=$1 AND p.supplier_id=$2 AND lower(p.po_number)=lower($3)
      AND coalesce(to_jsonb(p)->>'delivery_kind','WAREHOUSE')='WAREHOUSE'
      AND EXISTS(SELECT 1 FROM supplier_communications sent WHERE sent.workspace_id=p.workspace_id AND sent.purchase_order_id=p.id
        AND sent.supplier_id=p.supplier_id AND sent.status='SENT' AND sent.external_message_id IS NOT NULL
        AND sent.message_kind='purchase_order'
        AND sent.connector_id=$5 AND sent.external_thread_id=$6 AND lower(sent.recipient)=lower($4)
        AND sent.sent_at::timestamptz<=$7::timestamptz)
    ORDER BY p.id LIMIT 2 ${lock?'FOR UPDATE OF p':''}`,
  [workspaceId,message.supplier_id,requestedOrder,message.sender,message.connector_id,message.external_thread_id,message.received_at])).rows;
  if(orders.length!==1)throw new ValidationError('The original mail thread and exact purchase number must match one placed purchase order.');
  const time=new Date(message.received_at);
  if(!Number.isFinite(+time)||+time>Date.now()+300000)
    throw new ValidationError('Review the mailbox receipt time before using this supplier response.');
  const mail={id,connectorId:message.connector_id,providerAccountId:message.provider_account_id,
    receivedAt:time.toISOString(),fingerprint:hash({subject:message.subject,body:message.body_text,source:message.content_hash,
      thread:message.external_thread_id,sender:message.sender})};
  return {mail,message,order:orders[0]};
}

async function matchingLines(db,workspaceId,order,rows){
  const lines=(await db.query(`SELECT l.id,l.line_number,s.code,l.supplier_sku,i.unit_label,i.secondary_unit_label
    FROM purchase_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 AND l.quantity_units>l.quantity_received_units
    ORDER BY l.line_number,l.id`,[workspaceId,order.id])).rows;
  const chosen=new Set();
  return rows.map(row=>{
    const matched=lines.filter(line=>(!row.line||Number(row.line)===line.line_number)&&
      (!row.sku||same(row.sku,line.code))&&(!row.supplierSku||same(row.supplierSku,line.supplier_sku)));
    const [line]=matched;
    if(matched.length!==1||chosen.has(line.id))
      throw new ValidationError('Match each email row to one distinct, open purchase line and exact product code.');
    chosen.add(line.id);
    if(row.stockUnit&&!same(row.stockUnit,line.unit_label)||row.weightUnit&&!same(row.weightUnit,line.secondary_unit_label)||
      row.price&&Boolean(line.secondary_unit_label)!==(row.basis.toLowerCase()==='weight')||
      row.price&&(line.secondary_unit_label?!row.weightUnit:!row.stockUnit))
      throw new ValidationError('The supplier’s stock unit, weight unit or price basis differs from the saved purchase line.');
    return {lineId:line.id,...Object.fromEntries(['quantity','secondary','price'].filter(key=>row[key]).map(key=>[key,row[key]]))};
  }).sort((a,b)=>a.lineId.localeCompare(b.lineId));
}

async function intake(db,workspaceId,messageId){
  return db.transaction(async c=>{
    await policy.requireWorkspaceJob(c,workspaceId,31,'draft');
    const existing=(await c.query(`SELECT id FROM stockchief_runtime.supplier_link_submissions
      WHERE workspace_id=$1 AND kind='amendment' AND amendment ? 'mail' AND amendment->'mail'->>'id'=$2`,[workspaceId,messageId])).rows[0];
    if(existing)return {id:existing.id,replayed:true};
    const {mail,message,order}=await original(c,workspaceId,messageId,{lock:true});
    if(!['ORDERED','PARTIALLY_RECEIVED'].includes(order.status)||new Date(order.updated_at)>new Date(mail.receivedAt))
      throw new ValidationError('The supplier emailed before the last purchase change. Review the original or ask for the current remaining terms.');
    const document=parser.parse(message.subject,message.body_text);
    if(document.currency!==order.currency)throw new ValidationError('The supplier used a different currency. Review the original before changing this purchase.');
    const changes=await matchingLines(c,workspaceId,order,document.rows);
    await require('./po-amendment-lines').prepare(c,workspaceId,order,changes);
    const revision=hash(await source.currentSnapshot(c,workspaceId,order.id)),id=newId('supplierreply');
    const fingerprint=tokenFingerprint(document.date,changes,revision,mail);
    const payload=JSON.stringify({revision,changes,mail});
    const scoped={query:(sql,args)=>c.query(sql,args),transaction:operation=>operation(c)};
    await require('../commercial/storage-capacity').reserve(scoped,workspaceId,'supplier-amendment-mail:'+messageId,
      Buffer.byteLength(payload)+8192,{finished:true});
    const saved=await c.query(`INSERT INTO stockchief_runtime.supplier_link_submissions
      (id,workspace_id,token_hash,kind,expected_date,amendment,fingerprint,created_at)
      VALUES($1,$2,$3,'amendment',$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
    [id,workspaceId,order.token_hash,document.date,payload,fingerprint,mail.receivedAt]);
    if(!saved.rowCount){
      const replay=(await c.query(`SELECT id FROM stockchief_runtime.supplier_link_submissions
        WHERE workspace_id=$1 AND kind='amendment' AND amendment->'mail'->>'id'=$2`,[workspaceId,messageId])).rows[0];
      if(replay)return {id:replay.id,replayed:true};
      throw new ValidationError('The supplier response changed. Review the saved message.');
    }
    await require('./agent-po-delivery-dates').enqueue(c,workspaceId,id);
    return {id,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function onArrival(db,workspaceId,messageId){
  try{return await intake(db,workspaceId,messageId);}
  catch(error){
    if(![400,402,403,404,422].includes(error.status))throw error;
    await db.query(`UPDATE connection_email_messages SET native_review_state='NEEDS_REVIEW',native_review_reason=$3
      WHERE workspace_id=$1 AND id=$2 AND native_review_goal_id IS NULL`,[workspaceId,messageId,error.message]);
    return {held:true,reason:error.message};
  }
}

module.exports={kind,original,intake,onArrival};
