'use strict';
// Verify the canonical effect against the approved payload at commit, not merely
// the existence of an order identifier. No model, execution or extra authority.
const normalized=value=>value==null||String(value).trim()===''?null:String(value).trim();
const date=value=>value instanceof Date?value.toISOString().slice(0,10):normalized(value);
async function purchase(client,ctx,result,payload){
 if(!result?.purchaseOrderId||!payload?.lines?.length)return false;
 const order=(await client.query('SELECT * FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,result.purchaseOrderId])).rows[0];
 if(!order||order.status!=='DRAFT'||order.supplier_id!==payload.supplierId||normalized(order.reference)!==normalized(payload.reference)
  ||order.destination_location_id!==(payload.destinationLocationId||null)||date(order.expected_date)!==date(payload.expectedDate)
  ||payload.currency&&order.currency!==payload.currency||payload.poNumber&&order.po_number!==payload.poNumber)return false;
 const lines=(await client.query(`SELECT l.*,si.units_per_purchase_unit AS supplier_pack_size,si.last_unit_cost AS supplier_unit_cost
  FROM purchase_order_lines l LEFT JOIN supplier_items si ON si.workspace_id=l.workspace_id AND si.id=l.supplier_item_id
  WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 ORDER BY l.line_number`,[ctx.workspaceId,order.id])).rows;
 if(lines.length!==payload.lines.length||!Array.isArray(result.lineIds)||result.lineIds.length!==lines.length||new Set(result.lineIds).size!==lines.length)return false;
 return lines.every((row,index)=>{
  const approved=payload.lines[index],pack=Number(approved.unitsPerPurchaseUnit??row.supplier_pack_size??1),purchaseQuantity=Number(approved.quantityPurchaseUnits??Math.ceil(Number(approved.quantityUnits)/pack)),units=pack*purchaseQuantity,cost=approved.unitCost??row.supplier_unit_cost??null;
  return row.id===result.lineIds[index]&&row.sku_id===approved.skuId&&Number.isSafeInteger(pack)&&pack>0&&Number(row.units_per_purchase_unit)===pack&&Number(row.quantity_purchase_units)===purchaseQuantity
   &&(approved.quantityUnits==null||Number(approved.quantityUnits)===units)
   &&Number(row.quantity_units)===units&&Number(row.quantity_received_units)===0&&row.destination_location_id===(approved.destinationLocationId||payload.destinationLocationId)
   &&(cost===null?row.unit_cost===null:row.unit_cost!==null&&Number(row.unit_cost)===Number(cost))
   &&(cost===null?row.line_total===null:row.line_total!==null&&Math.abs(Number(row.line_total)-units*Number(cost))<0.000001);
 });
}
async function sales(client,ctx,result,payload){
 if(!result?.salesOrderId||!payload?.lines?.length)return false;
 const order=(await client.query('SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,result.salesOrderId])).rows[0];
 const customerAddress=payload.shipToAddress===undefined?(await client.query('SELECT shipping_address FROM customers WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,payload.customerId])).rows[0]?.shipping_address:payload.shipToAddress;
 const requestedDelivery=String(payload.deliveryMethod||'SHIP').trim().toUpperCase(),delivery=requestedDelivery==='OWN_DELIVERY'?'SHIP':requestedDelivery;
 if(!order||order.status!=='DRAFT'||order.customer_id!==payload.customerId||normalized(order.reference)!==normalized(payload.reference)
  ||order.currency!==(payload.currency||'USD')||order.delivery_method!==delivery
  ||normalized(order.ship_to_address)!==normalized(customerAddress)||normalized(order.fulfillment_location_id)!==normalized(payload.fulfillmentLocationId)
  ||date(order.needed_by)!==date(payload.neededBy)||payload.orderDate&&date(order.order_date)!==date(payload.orderDate)
  ||Number(order.tax_minor)!==Number(payload.taxMinor||0)||Number(order.discount_minor)!==Number(payload.discountMinor||0))return false;
 if(!Array.isArray(result.lineIds)||result.lineIds.length!==payload.lines.length||new Set(result.lineIds).size!==payload.lines.length)return false;
 const lines=(await client.query('SELECT * FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2 ORDER BY array_position($3::text[],id)',[ctx.workspaceId,order.id,result.lineIds])).rows;
 return lines.length===payload.lines.length&&lines.every((row,index)=>{const approved=payload.lines[index];return row.id===result.lineIds[index]&&row.sku_id===approved.skuId&&Number(row.quantity_ordered)===Number(approved.quantity)&&Number(row.quantity_fulfilled)===0&&row.unit_price_minor!==null&&Number(row.unit_price_minor)===Number(approved.unitPriceMinor);});
}
module.exports={purchase,sales};
