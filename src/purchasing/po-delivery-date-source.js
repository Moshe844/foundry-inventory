'use strict';
const {createHash}=require('node:crypto'),{hash}=require('../pricing/postgres-promotions'),policy=require('../commercial/agent-plan'),{ValidationError,NotFoundError}=require('../domain/errors');
const owner=require('./supplier-email-terms-source').owner;
const sha=value=>createHash('sha256').update(value).digest('hex'),instant=value=>new Date(value).getTime();
const orderSnapshotSql="md5((to_jsonb(po)-'updated_at'-'expected_date')::text||coalesce((SELECT string_agg(to_jsonb(captured_line)::text,'|' ORDER BY captured_line.id) FROM purchase_order_lines captured_line WHERE captured_line.workspace_id=po.workspace_id AND captured_line.purchase_order_id=po.id),''))";
async function currentSnapshot(db,workspaceId,orderId){
 return (await db.query(`SELECT po.expected_date,po.status,${orderSnapshotSql} AS snapshot
   FROM purchase_orders po WHERE po.workspace_id=$1 AND po.id=$2`,[workspaceId,orderId])).rows[0];
}
async function capture(c,workspaceId,id){
 return c.query(`INSERT INTO stockchief_runtime.agent_po_date_sources(source_id,workspace_id,purchase_order_id,captured_expected_date,captured_order_profile_hash)
  SELECT r.id,r.workspace_id,po.id,po.expected_date::text,${orderSnapshotSql} FROM stockchief_runtime.supplier_link_submissions r JOIN stockchief_runtime.supplier_order_links l ON l.workspace_id=r.workspace_id AND l.token_hash=r.token_hash JOIN purchase_orders po ON po.workspace_id=l.workspace_id AND po.id=l.purchase_order_id
  WHERE r.workspace_id=$1 AND r.id=$2 ON CONFLICT(source_id) DO NOTHING`,[workspaceId,id]);
}
function scope(p){return {supplierId:p.supplierId,supplierEmail:p.supplierEmail,destinationLocationId:p.destinationLocationId,currency:p.currency,products:p.products.map(row=>({skuId:row.skuId,code:row.code,unit:row.unit,precision:row.precision,purchaseUnit:row.purchaseUnit,unitsPerPurchaseUnit:row.unitsPerPurchaseUnit}))};}
async function facts(db,ctx,id){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,31,'draft');
 const r=(await db.query(`SELECT r.id,r.kind,r.expected_date::text AS proposed_date,r.fingerprint,r.amendment,r.created_at,r.created_at::text AS received_text,l.token_hash,l.recipient,l.expires_at,
  po.id AS order_id,po.po_number,po.supplier_id,po.destination_location_id,loc.name AS destination_name,po.currency,po.expected_date::text AS current_date,po.status,po.updated_at,
  to_jsonb(po)-'updated_at'-'expected_date' AS order_profile,${orderSnapshotSql} AS order_snapshot_hash,v.captured_expected_date,v.captured_order_profile_hash,
  v.processed_at,v.source_snapshot,v.instruction_hash,s.name AS supplier_name,s.email AS supplier_email,s.status AS supplier_status
  FROM stockchief_runtime.supplier_link_submissions r JOIN stockchief_runtime.supplier_order_links l ON l.token_hash=r.token_hash AND l.workspace_id=r.workspace_id
  JOIN purchase_orders po ON po.workspace_id=l.workspace_id AND po.id=l.purchase_order_id JOIN suppliers s ON s.workspace_id=po.workspace_id AND s.id=po.supplier_id
  JOIN locations loc ON loc.workspace_id=po.workspace_id AND loc.id=po.destination_location_id
  LEFT JOIN stockchief_runtime.agent_po_date_sources v ON v.workspace_id=r.workspace_id AND v.source_id=r.id
  WHERE r.workspace_id=$1 AND r.id=$2`,[ctx.workspaceId,id])).rows[0];
 if(!r)throw new NotFoundError('That supplier response is not in this inventory.');
 const commercial=r.kind==='amendment';
 const valid=commercial
  ?r.amendment?.changes?.length&&r.fingerprint===require('./po-amendment-link').tokenFingerprint(r.proposed_date,r.amendment.changes,r.amendment.revision,r.amendment.mail)
  :['date','confirm'].includes(r.kind)&&r.proposed_date&&r.fingerprint===sha(r.kind+'|'+r.proposed_date);
 if(!valid)throw new ValidationError('Review the original supplier response. Its exact submitted terms could not be verified.');
 const instructionHash=hash({token:r.token_hash,fingerprint:r.fingerprint,kind:r.kind,date:r.proposed_date,receivedAt:r.received_text});
 if(commercial&&r.processed_at){
  if(r.instruction_hash!==instructionHash)throw new ValidationError('The original supplier response changed after it was processed.');
  return {...r.source_snapshot,instructionHash};
 }
 if(r.supplier_status!=='active'||!r.supplier_email||r.supplier_email.toLowerCase()!==r.recipient.toLowerCase()||instant(r.expires_at)<=Date.now())throw new ValidationError('The original supplier link expired or its known supplier contact changed. Review the supplier directly before updating this order.');
 const rows=(await db.query(`SELECT l.id,l.sku_id AS "skuId",s.code,i.unit_label AS unit,i.quantity_precision::int AS precision,l.purchase_unit AS "purchaseUnit",l.units_per_purchase_unit::text AS "unitsPerPurchaseUnit",l.quantity_units::text AS quantity,l.unit_cost::text AS cost,l.quantity_received_units::text AS received
  FROM purchase_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 ORDER BY l.sku_id,l.id LIMIT 251`,[ctx.workspaceId,r.order_id])).rows;
 if(!rows.length||rows.length>250)throw new ValidationError('Review delivery dates for an order with one to 250 exact product lines at a time.');
 const p={sourceId:id,kind:r.kind,receivedAt:r.received_text,instructionHash,capturedDate:r.captured_expected_date,capturedProfileHash:r.captured_order_profile_hash,currentProfileHash:r.order_snapshot_hash,
  orderId:r.order_id,orderNumber:r.po_number,supplierId:r.supplier_id,supplierName:r.supplier_name,supplierEmail:r.supplier_email,destinationLocationId:r.destination_location_id,destinationName:r.destination_name,currency:r.currency,currentDate:r.current_date,proposedDate:r.proposed_date,status:r.status,updatedAt:r.updated_at,orderProfileHash:hash({order:r.order_profile,lines:rows}),products:rows};
 if(commercial){
  if(r.amendment.mail){
   const original=await require('./po-amendment-email').original(db,ctx.workspaceId,r.amendment.mail.id);
   if(original.order.id!==p.orderId||hash(original.mail)!==hash(r.amendment.mail))
    throw new ValidationError('The original supplier message or approved mailbox changed. Review the original email before changing this purchase.');
   p.mailSource=original.mail;
  }
  const revision=hash({expected_date:r.current_date,status:r.status,snapshot:r.order_snapshot_hash});
  if(revision!==r.amendment.revision)throw new ValidationError('The purchase order changed after this supplier response. Ask the supplier to submit its revised remaining quantities and prices against the current order.');
  const changes=await require('./po-amendment-lines').prepare(db,ctx.workspaceId,{id:p.orderId,currency:p.currency},r.amendment.changes);
  p.amendmentInput=r.amendment.changes;
  p.amendments=changes.map(({line,amendment})=>({lineId:line.id,number:line.line_number,code:line.code,name:line.name,
    unit:line.unit_label,weightUnit:line.secondary_unit_label,locationId:line.receiving_location,
    skuId:line.sku_id,pack:line.purchase_unit,packSize:line.units_per_purchase_unit,...amendment}));
 }
 p.scope=scope(p);p.sourceFingerprint=hash(p);return p;
}
function caps(input){
 const values={};for(const key of ['maximumShiftDays','maximumTotalShiftDays','maximumFutureDays']){const text=String(input[key]??'');if(!/^(?:0|[1-9]\d{0,2})$/.test(text)||Number(text)>365)throw new ValidationError('Enter every date limit explicitly, as whole days from zero to 365.');values[key]=Number(text);}return {...values,allowFirstDate:input.allowFirstDate==='yes'};
}
function violations(p,limits,today){
 if(!p.proposedDate)return [];
 const delta=(a,b)=>(Date.parse(a+'T00:00:00Z')-Date.parse(b+'T00:00:00Z'))/86400000,original=p.originalDate||p.currentDate,reasons=[];
 if(p.proposedDate<today)reasons.push('The submitted promise is already in the past.');
 if(delta(p.proposedDate,today)>limits.maximumFutureDays)reasons.push('The date is '+delta(p.proposedDate,today)+' days ahead; this scope allows '+limits.maximumFutureDays+'.');
 if(p.currentDate){const days=Math.abs(delta(p.proposedDate,p.currentDate));if(!Number.isFinite(days)||days>limits.maximumShiftDays)reasons.push('The current promise changes by '+(Number.isFinite(days)?days:'an unclear number of')+' days; this scope allows '+limits.maximumShiftDays+'.');}else if(!limits.allowFirstDate)reasons.push('This scope does not authorize filling an empty date.');
 if(original){const days=Math.abs(delta(p.proposedDate,original));if(!Number.isFinite(days)||days>limits.maximumTotalShiftDays)reasons.push('The total change from the original promise is '+(Number.isFinite(days)?days:'an unclear number of')+' days; this scope allows '+limits.maximumTotalShiftDays+'.');}
 return reasons;
}
function within(p,limits,today){return violations(p,limits,today).length===0;}
function covers(authorized,current){return authorized.supplierId===current.supplierId&&authorized.supplierEmail===current.supplierEmail&&authorized.destinationLocationId===current.destinationLocationId&&authorized.currency===current.currency&&current.products.every(product=>authorized.products.some(saved=>hash(saved)===hash(product)));}
module.exports={owner,facts,scope,caps,within,violations,covers,instant,capture,currentSnapshot};
