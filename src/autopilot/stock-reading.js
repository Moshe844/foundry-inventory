'use strict';
const exact=require('../domain/exact-quantity'),availability=require('../domain/postgres-stock-availability');

async function lookup(c,ctx,{filter,page=1,today}){
 const result=(await c.query(`WITH matched AS (SELECT DISTINCT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 WHERE s.workspace_id=$1 AND (lower(s.code)=lower($2) OR lower(i.name)=lower($2) OR lower(s.variant_label)=lower($2)
 OR EXISTS(SELECT 1 FROM lots lot WHERE lot.workspace_id=s.workspace_id AND lot.sku_id=s.id AND lower(lot.code)=lower($2))
 OR EXISTS(SELECT 1 FROM serial_units u WHERE u.workspace_id=s.workspace_id AND u.sku_id=s.id AND lower(u.serial)=lower($2)))),
 positions AS (
 SELECT s.id sku_id,i.id item_id,s.code sku,i.name product,s.variant_label identifier,l.id location_id,coalesce(l.name,'No recorded stock') location,'SKU balance' kind,
 coalesce(b.on_hand,0)::text units,b.secondary_on_hand::text secondary,i.unit_label,i.secondary_unit_label,false recalled,false expired
 FROM matched match JOIN skus s ON s.id=match.id JOIN items i ON i.id=s.item_id LEFT JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id
 LEFT JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id
 UNION ALL SELECT s.id,i.id,s.code,i.name,lot.code,l.id,l.name,'Lot',b.quantity::text,b.secondary_quantity::text,i.unit_label,i.secondary_unit_label,
 lot.recalled_at IS NOT NULL,lot.expires_at::date<$3::date
 FROM matched match JOIN skus s ON s.id=match.id JOIN items i ON i.id=s.item_id JOIN lots lot ON lot.workspace_id=s.workspace_id AND lot.sku_id=s.id
 JOIN lot_balances b ON b.workspace_id=lot.workspace_id AND b.lot_id=lot.id JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id
 WHERE lower(lot.code)=lower($2) OR NOT EXISTS(SELECT 1 FROM lots x WHERE x.workspace_id=$1 AND lower(x.code)=lower($2))
 UNION ALL SELECT s.id,i.id,s.code,i.name,u.serial,l.id,coalesce(l.name,'Issued'),'Serial',(u.status='in_stock')::int::text,
 u.secondary_quantity::text,i.unit_label,i.secondary_unit_label,lot.recalled_at IS NOT NULL,lot.expires_at::date<$3::date
 FROM matched match JOIN skus s ON s.id=match.id JOIN items i ON i.id=s.item_id JOIN serial_units u ON u.workspace_id=s.workspace_id AND u.sku_id=s.id
 LEFT JOIN locations l ON l.workspace_id=u.workspace_id AND l.id=u.location_id LEFT JOIN lots lot ON lot.workspace_id=u.workspace_id AND lot.id=u.lot_id
 WHERE lower(u.serial)=lower($2) OR NOT EXISTS(SELECT 1 FROM serial_units x WHERE x.workspace_id=$1 AND lower(x.serial)=lower($2)))
 SELECT * FROM positions ORDER BY sku,sku_id,kind,location,location_id,identifier LIMIT 101 OFFSET $4`,[ctx.workspaceId,filter,today,(page-1)*100])).rows;
 const more=result.length>100,selected=result.slice(0,100),ids=[...new Set(selected.map(r=>r.sku_id))];
 const stock=await availability.readMany(c,ctx.workspaceId,selected.filter(r=>r.location_id).map(r=>({skuId:r.sku_id,locationId:r.location_id})));
 const usable=await require('../domain/postgres-kit-availability').stock(c,ctx.workspaceId,ids),kits=await require('../domain/postgres-kit-availability').read(c,ctx.workspaceId,ids);
 const values=(await c.query('SELECT sku_id,location_id,quantity_units::text,total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=ANY($2::text[])',[ctx.workspaceId,ids])).rows;
 const commitments=(await c.query(`SELECT a.sku_id,a.location_id,o.order_number reference,'Customer order' kind,sum(a.quantity)::text quantity
 FROM sales_stock_commitments a JOIN sales_orders o ON o.workspace_id=a.workspace_id AND o.id=a.sales_order_id WHERE a.workspace_id=$1 AND a.sku_id=ANY($2::text[]) GROUP BY a.sku_id,a.location_id,o.id,o.order_number
 UNION ALL SELECT l.sku_id,t.source_location_id,coalesce(t.reference,t.id),'Internal transfer',sum(CASE t.status WHEN 'REQUESTED' THEN l.requested_quantity ELSE l.approved_quantity END)::text
 FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.workspace_id=l.workspace_id AND t.id=l.transfer_id WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND t.status IN ('REQUESTED','APPROVED','PICKED') GROUP BY l.sku_id,t.source_location_id,t.id,t.reference
 ORDER BY sku_id,location_id,kind,reference`,[ctx.workspaceId,ids])).rows;
 return {more,summary:'Recorded stock, lots and individual serials are separate views; do not add them together. Available stock excludes reservations, recalled or expired goods and protected custody. Missing recorded cost is held for review. Kit capacity uses the saved components. Independent weights are shown without estimating a conversion.',rows:selected.map(r=>{
  const key=availability.key(r.sku_id,r.location_id),s=stock.get(key),value=values.find(v=>v.sku_id===r.sku_id&&v.location_id===r.location_id),costKnown=Number(r.units)<=0||value&&Number(value.quantity_units)>=Number(s?.onHand||0);
  const free=usable.get(key)||0,held=s?exact.add(String(s.committed),String(s.reserved)):'0';
  let available=r.kind==='SKU balance'?costKnown?String(free):null:r.recalled||r.expired?'0':costKnown&&Number(held)===0?r.units:null;
  return {SKU:r.sku,Product:r.product,View:r.kind,'Variant or identifier':r.identifier,Location:r.location,Units:r.units,Unit:r.unit_label,
   'Independent quantity':r.secondary,'Independent unit':r.secondary_unit_label,Reserved:r.kind==='SKU balance'?held:null,Available:available,
   'Commitment records':r.kind==='SKU balance'?commitments.filter(x=>x.sku_id===r.sku_id&&x.location_id===r.location_id).map(x=>x.kind+' '+x.reference+': '+x.quantity).join('; ')||null:null,
   'Rental reservations':r.kind==='SKU balance'?String(s?.rentalReserved||0):null,'Return or quality holds':r.kind==='SKU balance'?String(s?.returnHeld||0):null,
   'Buildable kits':r.kind==='SKU balance'?(r.location_id?kits.get(r.sku_id)?.locations.find(l=>l.locationId===r.location_id)?.buildable:kits.get(r.sku_id)?.buildable)??null:null,
   Status:r.recalled?'Under recall':r.expired?'Expired':r.kind==='Serial'&&r.units==='0'?'Issued':!costKnown?'Stock cost needs review':r.kind==='Lot'&&Number(held)>0?'Exact lot availability needs allocation review':r.kind==='Serial'&&Number(held)>0?'Check which serial is promised':'Recorded',link:'/inventory/'+r.item_id};
 })};
}

async function movements(c,ctx,{filter='',page=1}){
 const rows=(await c.query(`SELECT i.name AS "Product",s.code AS "SKU",l.name AS "Location",m.occurred_at AS "When",m.operation AS "Action",
 (m.balance_after-m.quantity_delta)::text AS "Before",m.quantity_delta::text AS "Change",m.balance_after::text AS "After",i.unit_label AS "Unit",
 m.secondary_quantity_delta::text AS "Independent change",i.secondary_unit_label AS "Independent unit",lot.code AS "Lot",
 coalesce(serials.serials,u_serial.serial) AS "Serials",coalesce(nullif(m.reason_code,''),nullif(m.notes,''),m.operation) AS "Reason",
 m.reference AS "Reference",u.name AS "Recorded by",m.id AS "Movement",cost.cost_delta_minor AS "Cost change minor",book.base_currency AS "Currency",
 CASE WHEN cost.cost_source_type IN ('sales_order_fulfillment','sales_order_kit_fulfillment') THEN '/orders/'||cost.cost_source_record_id
 WHEN receipt.purchase_order_id IS NOT NULL THEN '/purchasing/orders/'||receipt.purchase_order_id ELSE '/inventory/'||i.id END AS link
 FROM movements m JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.sku_id JOIN items i ON i.workspace_id=m.workspace_id AND i.id=m.item_id
 JOIN locations l ON l.workspace_id=m.workspace_id AND l.id=m.location_id JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.actor_user_id
 LEFT JOIN lots lot ON lot.workspace_id=m.workspace_id AND lot.id=m.lot_id LEFT JOIN serial_units u_serial ON u_serial.workspace_id=m.workspace_id AND u_serial.id=m.serial_unit_id
 LEFT JOIN LATERAL(SELECT string_agg(u.serial,', ' ORDER BY u.serial) serials FROM stockchief_runtime.inventory_movement_serial_units x JOIN serial_units u ON u.workspace_id=x.workspace_id AND u.id=x.serial_unit_id WHERE x.workspace_id=m.workspace_id AND x.movement_id=m.id) serials ON true
 LEFT JOIN accounting_inventory_cost_movements cost ON cost.workspace_id=m.workspace_id AND cost.inventory_movement_id=m.id
 LEFT JOIN accounting_settings book ON book.workspace_id=m.workspace_id
 LEFT JOIN purchase_order_receipts receipt ON receipt.workspace_id=m.workspace_id AND receipt.id=cost.cost_source_record_id AND cost.cost_source_type='purchase_order_receipt'
 WHERE m.workspace_id=$1 AND ($2='' OR lower(s.code)=lower($2) OR lower(i.name)=lower($2) OR lower(s.variant_label)=lower($2) OR lower(lot.code)=lower($2)
 OR lower(u_serial.serial)=lower($2) OR EXISTS(SELECT 1 FROM stockchief_runtime.inventory_movement_serial_units x JOIN serial_units u ON u.workspace_id=x.workspace_id AND u.id=x.serial_unit_id WHERE x.workspace_id=m.workspace_id AND x.movement_id=m.id AND lower(u.serial)=lower($2)))
 ORDER BY m.occurred_at::timestamptz DESC,m.seq DESC LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 return {rows:rows.slice(0,100),more:rows.length>100,summary:'Every posted receipt, issue, transfer and adjustment retains its exact quantity, before and after balances, independent measure, tracked identity, responsible person and originating record. Reservations change availability without moving physical stock; the stock lookup shows their current total separately.'};
}
module.exports={lookup,movements};
