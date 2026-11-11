'use strict';

const {ValidationError}=require('../domain/errors');
const exact=require('../domain/exact-quantity');
const money=require('../domain/currency');
const quantities=require('./direct-shipment-quantities');
const {hash}=require('../pricing/postgres-promotions');

// Only the supplier-direct service can grant this context. All quantities and
// costs are then read again from its locked, durable supplier evidence.
async function prepare(db,ctx,order,input){
  const grant=require('./direct-shipment-authority').fulfillment(ctx);
  if(!grant)return null;
  const dispatch=(await db.query(`SELECT x.*,d.sales_order_id,d.facts,d.source_hash,p.currency,p.supplier_id,p.delivery_kind
    FROM stockchief_runtime.agent_direct_dispatches x
    JOIN stockchief_runtime.agent_direct_orders d ON d.workspace_id=x.workspace_id AND d.id=x.direct_order_id
    JOIN purchase_orders p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_id
    WHERE x.workspace_id=$1 AND x.id=$2 AND d.purchase_order_id=$3 FOR UPDATE OF x,d,p`,
    [ctx.workspaceId,grant.dispatchId,grant.purchaseOrderId])).rows[0];
  if(!dispatch||dispatch.sales_order_id!==order.id||dispatch.state!=='REVIEW'||!dispatch.purchase_receipt_id||
    dispatch.delivery_kind!=='CUSTOMER_DIRECT'||input.fulfilledAt!==dispatch.original.shippedAt)
    throw new ValidationError('This direct shipment does not match the current supplier dispatch evidence.');
  if(dispatch.currency!==order.currency)
    throw new ValidationError('The supplier purchase and customer sale use different currencies. Verify their conversion before posting this direct shipment.');
  const records=(await db.query(`SELECT x.*,l.sales_order_line_id,l.purchase_order_line_id,l.quantity AS promised_quantity,
    l.secondary_quantity AS promised_secondary,l.dispatched_quantity,l.dispatched_secondary_quantity,p.sku_id,p.unit_cost,
    i.unit_label,i.tracking_mode,i.quantity_precision,i.quantity_increment,i.secondary_unit_label,i.secondary_precision,i.secondary_increment
    FROM stockchief_runtime.agent_direct_dispatch_lines x
    JOIN stockchief_runtime.agent_direct_order_lines l ON l.workspace_id=x.workspace_id AND l.id=x.direct_order_line_id
    JOIN purchase_order_lines p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_line_id
    JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE x.workspace_id=$1 AND x.dispatch_id=$2 ORDER BY x.id FOR UPDATE OF x,l,p FOR SHARE OF i`,
    [ctx.workspaceId,dispatch.id])).rows;
  if(records.length!==input.lines.length||new Set(input.lines.map(line=>line.lineId)).size!==records.length)
    throw new ValidationError('Fulfill every recorded supplier dispatch line exactly once.');
  const result=new Map();
  for(const row of records){
    const product=dispatch.facts.products.find(product=>product.salesOrderLineId===row.sales_order_line_id);
    if(!product||hash(quantities.profileSnapshot(row))!==hash(product.stockProfile))
      throw new ValidationError('This product’s units or tracking method changed after the supplier purchase. Review its shipping evidence before fulfillment.');
    const requested=input.lines.find(line=>line.lineId===row.sales_order_line_id);
    const profile={...row},open={quantity:exact.subtract(row.promised_quantity,row.dispatched_quantity),
      secondary:row.promised_secondary==null?null:exact.subtract(row.promised_secondary,row.dispatched_secondary_quantity)};
    const verified=quantities.dispatch(profile,{...row.tracking,quantity:row.quantity,secondaryQuantity:row.secondary_quantity},
      open,dispatch.original.shippedAt.slice(0,10));
    if(!requested||exact.canonical(requested.quantity)!==exact.canonical(verified.quantity)||
      (requested.secondaryQuantity==null?null:exact.canonical(requested.secondaryQuantity))!==
      (verified.secondaryQuantity==null?null:exact.canonical(verified.secondaryQuantity))||
      requested.locationId!==dispatch.facts.businessLocationId)
      throw new ValidationError('The direct fulfillment quantities differ from the supplier’s confirmed shipping record.');
    const costMinor=exact.costMinor(verified.secondaryQuantity??verified.quantity,money.userToMinor(String(row.unit_cost),dispatch.currency));
    if(Number(row.cost_minor)!==costMinor)throw new ValidationError('The supplier’s dispatch cost changed. Review its current purchase price.');
    result.set(row.sales_order_line_id,{...verified,costMinor,supplierId:dispatch.supplier_id,
      carrier:dispatch.original.carrier,trackingNumber:dispatch.original.trackingNumber,shippedAt:dispatch.original.shippedAt,
      directOrderId:dispatch.direct_order_id,dispatchId:dispatch.id,dispatchLineId:row.id,
      purchaseOrderId:grant.purchaseOrderId,purchaseOrderLineId:row.purchase_order_line_id,
      receiptId:dispatch.purchase_receipt_id});
  }
  return result;
}

module.exports={prepare};
