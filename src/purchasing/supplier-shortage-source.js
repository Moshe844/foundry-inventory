'use strict';

const {ValidationError,NotFoundError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions');
const {compare,hasShortage}=require('./delivery-comparison');
const exact=require('../domain/exact-quantity');
const money=require('../domain/currency');

async function facts(db,ctx,{comparisonId,lineId}){
  const check=(await db.query(`SELECT * FROM stockchief_runtime.agent_delivery_comparisons
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,comparisonId])).rows[0];
  if(!check)throw new NotFoundError('Choose a saved delivery comparison in this inventory.');
  const original=check.source_snapshot;
  if(hash(original)!==check.source_hash||hash(compare(original.lines,check.result.original))!==hash(check.result))
    throw new ValidationError('The original delivery evidence changed. Check the delivery again before opening a claim.');
  const expected=original.lines.find(line=>line.id===lineId);
  const actual=check.result.rows.find(line=>line.lineId===lineId);
  if(!expected||!actual||!hasShortage(actual)||!check.result.original.some(row=>row.lineId===lineId))
    throw new ValidationError('Enter the actual quantity for this exact short line, including zero when nothing arrived.');
  const row=(await db.query(`SELECT l.quantity_units::text,l.quantity_received_units::text,
    l.secondary_quantity_ordered::text,l.secondary_quantity_received::text,l.unit_cost::text,l.sku_id,
    coalesce(l.destination_location_id,p.destination_location_id) AS location_id,place.name AS location_name,
    p.id AS purchase_order_id,p.po_number,p.currency,v.id AS supplier_id,v.name AS supplier_name,v.email,
    s.code,i.name,i.unit_label,i.tracking_mode,i.quantity_precision,i.secondary_unit_label,i.secondary_precision
    FROM purchase_order_lines l JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
    JOIN suppliers v ON v.workspace_id=p.workspace_id AND v.id=p.supplier_id AND v.status='active'
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    JOIN locations place ON place.workspace_id=l.workspace_id AND place.id=coalesce(l.destination_location_id,p.destination_location_id)
      AND place.is_active=1 AND place.custody_agreement_id IS NULL
    WHERE l.workspace_id=$1 AND l.id=$2 AND p.id=$3 AND l.supplier_amendment_closed_at IS NULL
      AND p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED') AND p.delivery_kind='WAREHOUSE'`,
  [ctx.workspaceId,lineId,check.purchase_order_id])).rows[0];
  if(!row||row.supplier_id!==original.order.supplier_id||row.currency!==original.order.currency||row.sku_id!==expected.sku_id||row.code!==expected.code||
    row.location_id!==(expected.destination_location_id||original.order.destination_location_id)||row.unit_label!==expected.unit_label||
    row.tracking_mode!==expected.tracking_mode||row.quantity_precision!==expected.quantity_precision||
    row.secondary_unit_label!==expected.secondary_unit_label||row.secondary_precision!==expected.secondary_precision||
    row.unit_cost==null||expected.unit_cost==null||exact.canonical(row.unit_cost)!==exact.canonical(expected.unit_cost)||
    exact.canonical(row.quantity_units)!==exact.canonical(expected.quantity_units)||
    exact.canonical(row.quantity_received_units)!==exact.add(expected.quantity_received_units,actual.observed))
    throw new ValidationError('The purchase line or received quantity changed. Check the current order and actual receipt before opening a claim.');

  const receipts=(await db.query(`SELECT r.id,r.received_at,rl.id AS receipt_line_id,rl.location_id,
    rl.quantity_units::text,rl.secondary_quantity::text,rl.lot_id,rl.serials
    FROM purchase_order_receipt_lines rl JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id
    WHERE rl.workspace_id=$1 AND rl.purchase_order_line_id=$2 AND r.purchase_order_id=$3
      AND r.reference=$4 AND r.created_at::timestamptz>=$5::timestamptz
    ORDER BY r.received_at,r.id,rl.id`,[ctx.workspaceId,lineId,check.purchase_order_id,check.source_reference,check.recorded_at])).rows;
  const sum=field=>receipts.reduce((total,receipt)=>exact.add(total,receipt[field]||'0'),'0');
  if(receipts.some(receipt=>receipt.location_id!==row.location_id)||sum('quantity_units')!==actual.observed)
    throw new ValidationError('Book the actual goods at the receiving location using the same delivery reference before opening a claim.');
  let missingWeight=null;
  if(row.secondary_unit_label){
    if(actual.expectedWeight==null||actual.observedWeight==null||sum('secondary_quantity')!==actual.observedWeight||
      exact.canonical(row.secondary_quantity_ordered)!==exact.canonical(expected.secondary_quantity_ordered)||
      exact.canonical(row.secondary_quantity_received||'0')!==exact.add(expected.secondary_quantity_received||'0',actual.observedWeight))
      throw new ValidationError('Check the independent ordered and actual received weight before opening a measured-goods claim.');
    missingWeight=exact.subtract(actual.expectedWeight,actual.observedWeight);
    if(Number(missingWeight)<=0)throw new ValidationError('Record a positive missing weight from the original order and the exact physical receipt.');
  }
  const currency=money.code(row.currency);
  const unitCostMinor=money.userToMinor(row.unit_cost,currency,{label:'Recorded supplier unit cost'});
  const missingUnits=actual.short>0?exact.subtract(actual.expected,actual.observed):'0';
  const totalMinor=exact.costMinor(missingWeight??missingUnits,unitCostMinor);
  return {row,check,receipts,actual,missingUnits,missingWeight,currency,unitCostMinor,totalMinor,
    receivedAt:receipts.at(-1)?.received_at||new Date(check.recorded_at).toISOString()};
}

module.exports={facts};
