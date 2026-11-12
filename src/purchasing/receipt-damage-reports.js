'use strict';
// Job 45 evidence: staff mark a receipt line "arrived damaged" on the
// receiving form. The receiving route writes those units off through the
// damaged-stock removal; this report keeps the person, the units and the note
// with the exact receipt line, so a supplier claim can be opened from it.
const {ValidationError,NotFoundError}=require('../domain/errors'),{newId}=require('../lib/util');
const exact=require('../domain/exact-quantity');

async function record(db,ctx,{receiptId,purchaseOrderLineId,quantity,note,removalKey}){
 return db.transaction(async c=>{
  const lines=(await c.query(`SELECT rl.id,rl.quantity_units::text AS quantity FROM purchase_order_receipt_lines rl
   JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id
   WHERE rl.workspace_id=$1 AND rl.receipt_id=$2 AND rl.purchase_order_line_id=$3 FOR SHARE OF rl`,
  [ctx.workspaceId,receiptId,purchaseOrderLineId])).rows;
  if(lines.length!==1)throw new ValidationError('Record damage against one exact received line of this delivery.');
  const line=lines[0];
  if(exact.canonical(quantity)!==exact.canonical(line.quantity))throw new ValidationError('The damaged quantity must be the units received on this line.');
  const text=String(note||'').trim()||'Marked as arrived damaged on the receiving form.';
  if(text.length>1000)throw new ValidationError('Describe the damage in up to 1,000 characters.');
  const prior=(await c.query('SELECT id FROM stockchief_runtime.agent_receipt_damage_reports WHERE workspace_id=$1 AND receipt_line_id=$2',[ctx.workspaceId,line.id])).rows[0];
  if(prior)return {id:prior.id,replayed:true};
  const id=newId('damage-report');
  await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'damage-report:'+line.id,Buffer.byteLength(text)+2048,{finished:true});
  await c.query(`INSERT INTO stockchief_runtime.agent_receipt_damage_reports(id,workspace_id,receipt_line_id,quantity,note,removal_key,reported_by)
   VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,ctx.workspaceId,line.id,exact.canonical(quantity),text,String(removalKey||''),ctx.actorId]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Staff damage report recorded at receiving',reference:id,
   after:{receiptId,receiptLineId:line.id,purchaseOrderLineId,quantity:exact.canonical(quantity),note:text}});
  return {id,replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}

const SELECT=`SELECT d.id,d.quantity::text AS quantity,d.note,d.reported_by,d.created_at,u.name AS reporter,rl.id AS receipt_line_id,
 rl.receipt_id,rl.purchase_order_line_id,rl.location_id,r.received_at,r.reference AS receipt_reference,o.id AS purchase_order_id,o.po_number,
 v.name AS supplier_name,s.code,i.name AS product,i.unit_label
 FROM stockchief_runtime.agent_receipt_damage_reports d
 JOIN users u ON u.id=d.reported_by
 JOIN purchase_order_receipt_lines rl ON rl.workspace_id=d.workspace_id AND rl.id=d.receipt_line_id
 JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id
 JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id
 JOIN suppliers v ON v.workspace_id=o.workspace_id AND v.id=o.supplier_id
 JOIN skus s ON s.workspace_id=rl.workspace_id AND s.id=rl.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id`;

async function get(db,ctx,id){
 const row=(await db.query(SELECT+' WHERE d.workspace_id=$1 AND d.id=$2',[ctx.workspaceId,id])).rows[0];
 if(!row)throw new NotFoundError('That damage report is not in this inventory.');
 return row;
}
async function forReceipt(db,ctx,receiptId){
 return (await db.query(SELECT+' WHERE d.workspace_id=$1 AND rl.receipt_id=$2 ORDER BY d.created_at,d.id',[ctx.workspaceId,receiptId])).rows;
}
// One delivery's evidence: what staff reported damaged, and the claims made
// from it. Staff who receive goods can read it; only the owner claims.
async function page(db,ctx,receiptId){
 const user=await require('../operations/agent-quality-holds').actor(db,ctx,{lock:false});
 const receipt=(await db.query(`SELECT r.id,r.received_at,r.reference,r.note,o.id AS purchase_order_id,o.po_number,v.name AS supplier_name,
  (SELECT array_agg(DISTINCT rl.location_id) FROM purchase_order_receipt_lines rl WHERE rl.workspace_id=r.workspace_id AND rl.receipt_id=r.id) AS location_ids
  FROM purchase_order_receipts r JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id
  JOIN suppliers v ON v.workspace_id=o.workspace_id AND v.id=o.supplier_id WHERE r.workspace_id=$1 AND r.id=$2`,[ctx.workspaceId,receiptId])).rows[0];
 if(!receipt)throw new NotFoundError('That delivery is not in this inventory.');
 await require('../operations/postgres-warehouse-access').assertLocations(db,ctx,receipt.location_ids||[]);
 const reports=await forReceipt(db,ctx,receiptId);
 const claims=(await db.query(`SELECT id,reference,damage_report_id,communication_id IS NOT NULL AS sent,outcome FROM stockchief_runtime.agent_supplier_claims
  WHERE workspace_id=$1 AND damage_report_id=ANY($2::text[])`,[ctx.workspaceId,reports.map(r=>r.id)])).rows;
 const policy=require('../commercial/agent-plan'),state=await policy.accountState(db,ctx.workspaceId),owner=user.role==='owner';
 const canClaim=owner&&policy.usesAgentTerms(state)&&policy.permits(state.plan,45,'draft'),canAddPhotos=policy.usesAgentTerms(state)&&policy.permits(state.plan,46,'draft');
 const photos=require('../operations/quality-photos'),receiptPhotos=await photos.list(db,ctx,{receiptId});
 // Photos taken at a failed QC inspection of this delivery belong to the same set.
 const holdPhotos=(await db.query(`SELECT q.id,q.filename,q.caption,q.created_at,q.hold_id FROM stockchief_runtime.agent_quality_photos q
  JOIN stockchief_runtime.agent_quality_holds h ON h.workspace_id=q.workspace_id AND h.id=q.hold_id
  JOIN purchase_order_receipt_lines rl ON rl.workspace_id=h.workspace_id AND rl.id=h.receipt_line_id
  WHERE q.workspace_id=$1 AND rl.receipt_id=$2 ORDER BY q.created_at,q.id LIMIT 30`,[ctx.workspaceId,receiptId])).rows;
 return {receipt,reports:reports.map(r=>({...r,quantity:exact.canonical(r.quantity),claim:claims.find(c=>c.damage_report_id===r.id)||null})),owner,canClaim,canAddPhotos,receiptPhotos,holdPhotos,
  plan:state.plan,remedies:require('./supplier-claim-source').REMEDIES,claimMailboxes:canClaim?await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId):[]};
}
module.exports={record,get,forReceipt,page};
