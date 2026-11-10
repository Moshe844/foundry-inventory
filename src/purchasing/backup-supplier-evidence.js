'use strict';

const {ValidationError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions');
const exact=require('../domain/exact-quantity');
const dayMs=24*60*60*1000;

function openQuantity(line){
  return exact.subtract(line.quantity_units,line.quantity_received_units||'0');
}

function confirmationEvidence(line,documents,replies){
  if(exact.safeNumber(line.confirmed_units||0)>0)return {kind:'recorded_line_confirmation'};
  const accepted=documents.find(document=>document.document_type==='order_acknowledgement'&&document.status==='MATCHED');
  if(accepted)return {kind:'matched_supplier_confirmation',reference:accepted.id};
  const link=replies.find(reply=>reply.kind==='confirm');
  if(link)return {kind:'supplier_link_confirmation',reference:link.id};
  const pending=documents.find(document=>document.document_type==='order_acknowledgement'&&document.status==='NEEDS_REVIEW');
  if(pending||replies.some(reply=>reply.kind==='date'))return {kind:'supplier_response_needs_review',reference:pending?.id};
  return null;
}

function overdue(line,communications,documents,replies,days,now){
  const remaining=openQuantity(line);
  if(exact.safeNumber(remaining,{signed:true})<=0||!['APPROVED','ORDERED','PARTIALLY_RECEIVED'].includes(line.status))return null;
  if(confirmationEvidence(line,documents,replies))return null;
  const sent=communications.filter(receipt=>receipt.status==='SENT'&&receipt.external_message_id&&receipt.sent_at)
    .sort((a,b)=>Date.parse(a.sent_at)-Date.parse(b.sent_at))[0];
  // The native mark-as-ordered action supplies evidence for a manually placed PO.
  const sentAt=sent?.sent_at||line.ordered_at;
  if(!sentAt||!Number.isFinite(Date.parse(sentAt)))return null;
  const due=Date.parse(sentAt)+days*dayMs;
  if(due>now)return null;
  return {kind:'confirmation_overdue',purchaseOrderId:line.purchase_order_id,lineId:line.id,
    remaining,sentAt,receiptId:sent?.id||null,confirmationDays:days,dueAt:new Date(due).toISOString()};
}

async function candidates(db,workspaceId,rule,{now=Date.now()}={}){
  const today=await require('../lib/business-time').today(db,workspaceId,new Date(now));
  const notice=(await db.query(`SELECT id,purchase_order_id,line_id,supplier_reply_id,evidence,reference_quantity::text,secondary_quantity::text,
    source_fingerprint,reported_at,valid_through::text
    FROM stockchief_runtime.agent_backup_supplier_notices n
    WHERE n.workspace_id=$1 AND n.sku_id=$2 AND n.location_id=$3 AND n.supplier_id=$4 AND n.revoked_at IS NULL
      AND n.valid_through >= $5::date AND n.reported_at <= to_timestamp($6/1000.0)
      AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.supplier_link_submissions r JOIN stockchief_runtime.supplier_order_links l
        ON l.token_hash=r.token_hash AND l.workspace_id=r.workspace_id WHERE l.workspace_id=n.workspace_id
        AND l.purchase_order_id=n.purchase_order_id AND r.kind IN('confirm','date') AND r.created_at>n.reported_at)
      AND NOT EXISTS(SELECT 1 FROM supplier_documents d WHERE d.workspace_id=n.workspace_id AND d.purchase_order_id=n.purchase_order_id
        AND d.document_type='order_acknowledgement' AND d.status IN('MATCHED','NEEDS_REVIEW') AND d.processed_at::timestamptz>n.reported_at)
      AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_backup_supplier_runs s WHERE s.workspace_id=n.workspace_id
        AND s.rule_id=$7 AND s.trigger_key='notice:'||n.id)
    ORDER BY reported_at DESC,id LIMIT 1`,[workspaceId,rule.sku_id,rule.location_id,rule.primary_supplier_id,today,now,rule.id])).rows[0];
  if(notice)return {kind:'supplier_unavailable',purchaseOrderId:notice.purchase_order_id,lineId:notice.line_id,notice};
  const lines=(await db.query(`SELECT p.id AS purchase_order_id,p.po_number,p.status,p.ordered_at,l.id,l.quantity_units::text,
    l.quantity_received_units::text,coalesce(e.confirmed_units,0)::text AS confirmed_units
    FROM purchase_orders p JOIN purchase_order_lines l ON l.purchase_order_id=p.id AND l.workspace_id=p.workspace_id
    LEFT JOIN purchase_order_line_expectations e ON e.purchase_order_line_id=l.id AND e.workspace_id=l.workspace_id
    WHERE p.workspace_id=$1 AND p.supplier_id=$2 AND p.status IN('APPROVED','ORDERED','PARTIALLY_RECEIVED')
      AND l.sku_id=$3 AND coalesce(l.destination_location_id,p.destination_location_id)=$4
      AND l.quantity_units>l.quantity_received_units
    ORDER BY p.created_at,p.id,l.line_number,l.id`,[workspaceId,rule.primary_supplier_id,rule.sku_id,rule.location_id])).rows;
  if(!lines.length)return null;
  const ids=[...new Set(lines.map(line=>line.purchase_order_id))];
  const communications=(await db.query(`SELECT id,purchase_order_id,status,sent_at,external_message_id FROM supplier_communications
    WHERE workspace_id=$1 AND purchase_order_id=ANY($2::text[]) AND message_kind='purchase_order'
      AND status='SENT' AND external_message_id IS NOT NULL`,[workspaceId,ids])).rows;
  const documents=(await db.query(`SELECT id,purchase_order_id,document_type,status FROM supplier_documents
    WHERE workspace_id=$1 AND purchase_order_id=ANY($2::text[]) AND document_type='order_acknowledgement' AND status IN('MATCHED','NEEDS_REVIEW')`,[workspaceId,ids])).rows;
  const replies=(await db.query(`SELECT s.id,s.kind,l.purchase_order_id FROM stockchief_runtime.supplier_link_submissions s
    JOIN stockchief_runtime.supplier_order_links l ON l.token_hash=s.token_hash AND l.workspace_id=s.workspace_id
    WHERE s.workspace_id=$1 AND l.purchase_order_id=ANY($2::text[]) AND s.kind IN('confirm','date')`,[workspaceId,ids])).rows;
  const completed=new Set((await db.query(`SELECT trigger_key FROM stockchief_runtime.agent_backup_supplier_runs
    WHERE workspace_id=$1 AND rule_id=$2 AND purchase_order_id=ANY($3::text[])`,[workspaceId,rule.id,ids])).rows.map(row=>row.trigger_key));
  for(const line of lines){
    const onOrder=record=>record.purchase_order_id===line.purchase_order_id;
    const trigger=overdue(line,communications.filter(onOrder),documents.filter(onOrder),replies.filter(onOrder),rule.confirmation_days,now);
    if(trigger&&!completed.has(triggerKey(trigger)))return trigger;
  }
  return null;
}

function triggerKey(trigger){
  return trigger.kind==='supplier_unavailable'?'notice:'+trigger.notice.id:'overdue:'+trigger.purchaseOrderId+':'+trigger.lineId+':'+trigger.sentAt;
}

function proofFor(rule,trigger){
  if(!trigger)throw new ValidationError('The primary supplier has no current unavailability or overdue confirmation evidence.');
  return hash({revision:rule.revision,sku:rule.sku_id,location:rule.location_id,
    primary:rule.primary_supplier_id,backup:rule.backup_supplier_id,offer:rule.backup_offer_hash,trigger});
}

module.exports={candidates,confirmationEvidence,overdue,proofFor,triggerKey};
