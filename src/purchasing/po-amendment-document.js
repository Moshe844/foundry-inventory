'use strict';

// Job 31: a supplier document saved as evidence (an order acknowledgement,
// backorder notice or price update from a trusted supplier message) that
// changes a placed purchase line's quantity or price, or the order's date,
// becomes a purchase-change source. It then goes through the same review,
// limits, teaching and native revision as a change sent through the
// supplier's link or a reply on the purchase email thread.
const {createHash,randomBytes}=require('node:crypto');
const {ValidationError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions');
const {newId}=require('../lib/util');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');
const source=require('./po-delivery-date-source');

const kind='purchase-order.supplier-document-amendment.v1';
const TYPES=new Set(['order_acknowledgement','backorder_notice','price_update']);
const CHANGES=new Set(['quantity_changed','price_changed','delivery_date_changed']);
// Only these recorded differences can become a purchase change. Anything
// else in the document needs a person.
const READY=new Set([...CHANGES,'backorder_notice','price_update']);
const HELD={
  currency_changed:'The supplier used a different currency. Review the original before changing this purchase.',
  partial_confirmation:'The supplier confirmed only some of the lines. Check which goods are still coming before changing this purchase.',
  conflicting_document_version:'An earlier supplier document says something different. Review both before changing this purchase.',
};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse=value=>typeof value==='string'?JSON.parse(value):value;

// The saved document must still be the one the supplier sent: a trusted
// message from this order's supplier with the same content and attachments.
async function original(db,workspaceId,documentId,{lock=false}={}){
  const row=(await db.query(`SELECT d.id,d.document_type,d.status,d.facts,d.discrepancies,d.content_hash,d.supplier_id,
      d.message_id,m.content_hash AS message_hash,m.received_at,m.trust_status,m.classification,m.supplier_id AS message_supplier,
      m.connector_id,c.provider_account_id,p.id AS order_id,p.po_number,p.status AS order_status,p.currency,p.updated_at,
      p.expected_date::text AS expected_date,p.supplier_id AS order_supplier,coalesce(to_jsonb(p)->>'delivery_kind','WAREHOUSE') AS delivery_kind,
      s.status AS supplier_status,s.email AS supplier_email
    FROM supplier_documents d JOIN connection_email_messages m ON m.workspace_id=d.workspace_id AND m.id=d.message_id
    JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id
    JOIN purchase_orders p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_id
    JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
    WHERE d.workspace_id=$1 AND d.id=$2 ${lock?'FOR UPDATE OF p':''}`,[workspaceId,documentId])).rows[0];
  if(!row||!TYPES.has(row.document_type))
    throw new ValidationError('Choose a saved supplier confirmation, backorder notice or price update for this purchase.');
  if(row.status!=='NEEDS_REVIEW')throw new ValidationError('This supplier document was already reviewed or set aside.');
  if(row.trust_status!=='TRUSTED'||row.classification!=='supplier'||row.message_supplier!==row.order_supplier||
    row.supplier_id!==row.order_supplier||row.supplier_status!=='active'||!row.supplier_email)
    throw new ValidationError('The supplier document must come from this purchase order’s known, trusted supplier.');
  if(row.delivery_kind!=='WAREHOUSE')throw new ValidationError('Supplier-direct deliveries have their own change review.');
  const attachments=(await db.query('SELECT content_hash FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2 ORDER BY id',
    [workspaceId,row.message_id])).rows;
  if(digest({messageId:row.message_id,contentHash:row.message_hash,attachments:attachments.map(a=>a.content_hash)})!==row.content_hash)
    throw new ValidationError('The supplier’s original message or its attachments changed after the document was saved. Review the original.');
  const time=new Date(row.received_at);
  if(!Number.isFinite(+time)||+time>Date.now()+300000)throw new ValidationError('Review the mailbox receipt time before using this supplier document.');
  const document={id:row.id,messageId:row.message_id,connectorId:row.connector_id,providerAccountId:row.provider_account_id,
    receivedAt:time.toISOString(),fingerprint:hash({content:row.content_hash,type:row.document_type,facts:parse(row.facts),differences:parse(row.discrepancies)})};
  return {document,row,mailSource:{...document,id:row.message_id,documentId:row.id,source:'document'}};
}

// Turn the recorded supplier facts into exact remaining quantities, prices and
// a date. Unclear facts stop here and wait for a person.
async function changesFrom(db,workspaceId,row){
  const facts=parse(row.facts)||{},differences=parse(row.discrepancies)||[];
  for(const difference of differences)if(!READY.has(difference.kind))
    throw new ValidationError(HELD[difference.kind]||'This supplier document needs a person to review it.');
  if(facts.currency&&facts.currency!==row.currency)throw new ValidationError(HELD.currency_changed);
  if(!Array.isArray(facts.lines)||!facts.lines.length)throw new ValidationError('The supplier document has no purchase lines to compare.');
  const lines=(await db.query(`SELECT l.id,l.quantity_units::text AS ordered,l.quantity_received_units::text AS received,l.unit_cost::text AS cost,
      l.supplier_amendment_closed_at,s.code,i.secondary_unit_label
    FROM purchase_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE l.workspace_id=$1 AND l.purchase_order_id=$2`,[workspaceId,row.order_id])).rows;
  const byId=new Map(lines.map(line=>[line.id,line]));
  const open=lines.filter(line=>!line.supplier_amendment_closed_at&&exact.atoms(exact.subtract(line.ordered,line.received),6,{signed:true})>0);
  const changes=[];
  for(const fact of facts.lines){
    const line=byId.get(fact.lineId);
    if(!line||line.supplier_amendment_closed_at)
      throw new ValidationError('A line in the supplier document is no longer open on this purchase. Review the current order.');
    const change={lineId:line.id};
    if(row.document_type==='order_acknowledgement'&&fact.quantity!=null&&exact.canonical(String(fact.quantity))!==exact.canonical(line.ordered)){
      const remaining=exact.subtract(String(fact.quantity),line.received);
      if(exact.atoms(remaining,6,{signed:true})<0)
        throw new ValidationError('The supplier confirmed fewer units of '+line.code+' than you have already received. Review the receipts.');
      change.quantity=exact.canonical(remaining);
    }
    if(fact.unitCostMinor!=null){
      if(!Number.isSafeInteger(fact.unitCostMinor)||fact.unitCostMinor<0)
        throw new ValidationError('The supplier price for '+line.code+' is not an exact amount per stock unit. Review the original.');
      const current=money.toMinor(line.cost,row.currency,{optional:true,label:'Current purchase price'});
      if(current!==fact.unitCostMinor)change.price=money.fromMinor(fact.unitCostMinor,row.currency);
    }
    if(Object.keys(change).length===1)continue;
    if(line.secondary_unit_label)
      throw new ValidationError(line.code+' is bought by weight. Enter the supplier’s revised weight and price yourself.');
    changes.push(change);
  }
  let date=null;
  if(facts.expectedArrivalDate&&facts.expectedArrivalDate!==row.expected_date){
    const named=new Set(facts.lines.map(line=>line.lineId));
    if(!open.every(line=>named.has(line.id)))
      throw new ValidationError('The supplier gave a new date for only some lines. Check which goods it applies to before changing the order date.');
    date=facts.expectedArrivalDate;
  }
  if(!changes.length&&!date)throw new ValidationError('This supplier document matches the current purchase order. Nothing needs to change.');
  return {changes:changes.sort((a,b)=>a.lineId.localeCompare(b.lineId)),date};
}

function fingerprint(date,changes,revision,document){
  return createHash('sha256').update('amendment|'+hash({date,changes,revision,document})).digest('hex');
}

async function intake(db,workspaceId,documentId){
  return db.transaction(async c=>{
    await policy.requireWorkspaceJob(c,workspaceId,31,'draft');
    const existing=(await c.query(`SELECT id FROM stockchief_runtime.supplier_link_submissions
      WHERE workspace_id=$1 AND kind='amendment' AND amendment ? 'document' AND amendment->'document'->>'id'=$2`,[workspaceId,documentId])).rows[0];
    if(existing)return {id:existing.id,replayed:true};
    const {document,row}=await original(c,workspaceId,documentId,{lock:true});
    if(!['ORDERED','PARTIALLY_RECEIVED'].includes(row.order_status))
      throw new ValidationError('Only a placed purchase with goods still due can take supplier changes.');
    if(new Date(row.updated_at)>new Date(document.receivedAt))
      throw new ValidationError('The purchase changed after the supplier sent this document. Review the original or ask the supplier for the current terms.');
    const {changes,date}=await changesFrom(c,workspaceId,row);
    const order={id:row.order_id,currency:row.currency};
    if(changes.length)await require('./po-amendment-lines').prepare(c,workspaceId,order,changes);
    const revision=hash(await source.currentSnapshot(c,workspaceId,row.order_id));
    // Keep the source on this order's supplier link. When the order has none,
    // a source-only link is saved; no URL is issued for it.
    let token=(await c.query(`SELECT token_hash FROM stockchief_runtime.supplier_order_links
      WHERE workspace_id=$1 AND purchase_order_id=$2 AND recipient=lower($3) ORDER BY expires_at DESC,token_hash LIMIT 1`,
    [workspaceId,row.order_id,row.supplier_email])).rows[0]?.token_hash;
    const id=newId('supplierreply'),payload=JSON.stringify({revision,changes,document});
    const scoped={query:(sql,args)=>c.query(sql,args),transaction:operation=>operation(c)};
    await require('../commercial/storage-capacity').reserve(scoped,workspaceId,'supplier-amendment-document:'+documentId,
      Buffer.byteLength(payload)+8192,{finished:true});
    if(!token){
      token=randomBytes(32).toString('hex');
      await c.query(`INSERT INTO stockchief_runtime.supplier_order_links(token_hash,workspace_id,purchase_order_id,recipient,expires_at)
        VALUES($1,$2,$3,lower($4),now()+interval '90 days')`,[token,workspaceId,row.order_id,row.supplier_email]);
    }
    const saved=await c.query(`INSERT INTO stockchief_runtime.supplier_link_submissions
      (id,workspace_id,token_hash,kind,expected_date,amendment,fingerprint,created_at)
      VALUES($1,$2,$3,'amendment',$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
    [id,workspaceId,token,date,payload,fingerprint(date,changes,revision,document),document.receivedAt]);
    if(!saved.rowCount)throw new ValidationError('The supplier document changed. Review the saved original.');
    await require('./agent-po-delivery-dates').enqueue(c,workspaceId,id);
    return {id,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Worker: plans without job 31 keep the document for a person as before.
async function onDocument(db,workspaceId,documentId){
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,31,'draft'))return {skipped:'plan'};
  try{return await intake(db,workspaceId,documentId);}
  catch(error){
    if(![400,402,403,404,422].includes(error.status))throw error;
    await db.query(`UPDATE connection_email_messages m SET native_review_state='NEEDS_REVIEW',native_review_reason=$3
      FROM supplier_documents d WHERE d.workspace_id=$1 AND d.id=$2 AND m.workspace_id=d.workspace_id AND m.id=d.message_id
        AND m.native_review_goal_id IS NULL`,[workspaceId,documentId,String(error.message).slice(0,500)]);
    return {held:true,reason:error.message};
  }
}

// Called where the supplier evidence is recorded, in the same transaction.
async function queue(client,workspaceId,{documentId,documentType,status,orderStatus,differences}){
  if(status!=='NEEDS_REVIEW'||!TYPES.has(documentType)||!['ORDERED','PARTIALLY_RECEIVED'].includes(orderStatus)||
    !differences.some(difference=>CHANGES.has(difference.kind)))return null;
  const state=await policy.accountState(client,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,31,'draft'))return null;
  const db={query:(sql,args)=>client.query(sql,args),transaction:operation=>operation(client)};
  return require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind,idempotencyKey:'supplier-document-amendment:'+documentId,
    payload:{documentId},priority:55,maxAttempts:3});
}

module.exports={kind,TYPES,original,changesFrom,intake,onDocument,queue,fingerprint};
