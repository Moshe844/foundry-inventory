'use strict';
const exact=require('./exact-quantity');
const {ValidationError}=require('./errors');
const key=(skuId,locationId)=>JSON.stringify([skuId,locationId]);
const POSITION_SQL=` SELECT p.sku_id,p.location_id,loc.custody_agreement_id,coalesce(b.on_hand,0)::text on_hand,
  coalesce(lb.quantity,0)::text lot_quantity,coalesce(sales.quantity,0)::text committed,
  coalesce(transfers.quantity,0)::text transfer_quantity,coalesce(transfers.lot_quantity,0)::text lot_reserved
 FROM requested p JOIN skus s ON s.workspace_id=$1 AND s.id=p.sku_id AND s.is_active=1
 JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
 JOIN locations loc ON loc.workspace_id=s.workspace_id AND loc.id=p.location_id AND loc.is_active=1
 LEFT JOIN balances b ON b.workspace_id=$1 AND b.sku_id=s.id AND b.location_id=loc.id
 LEFT JOIN lots chosen_lot ON chosen_lot.workspace_id=$1 AND chosen_lot.sku_id=s.id AND chosen_lot.id=$3
 LEFT JOIN lot_balances lb ON lb.workspace_id=$1 AND lb.lot_id=chosen_lot.id AND lb.location_id=loc.id
 LEFT JOIN LATERAL(SELECT sum(a.quantity) quantity FROM sales_stock_commitments a
  WHERE a.workspace_id=$1 AND a.sku_id=s.id AND a.location_id=loc.id
   AND ($5::text IS NULL OR a.reserved_for_customer_id IS DISTINCT FROM $5)
   AND ($6::text IS NULL OR a.stock_reservation_id IS DISTINCT FROM $6))sales ON true
 LEFT JOIN LATERAL(SELECT sum(CASE WHEN t.status='REQUESTED' THEN l.requested_quantity ELSE l.approved_quantity END) quantity,
  sum(CASE WHEN t.status='REQUESTED' THEN l.requested_quantity ELSE l.approved_quantity END) FILTER(WHERE $3::text IS NULL OR l.lot_id=$3) lot_quantity
  FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.workspace_id=l.workspace_id AND t.id=l.transfer_id
  WHERE l.workspace_id=$1 AND l.sku_id=s.id AND t.source_location_id=loc.id AND t.status IN ('REQUESTED','APPROVED','PICKED')
   AND ($4::text IS NULL OR t.id<>$4))transfers ON true`;
// customerId lets that customer's own order use stock protected for it (job 12);
// reservationId reads a position as if that one protection were not held.
async function readMany(c,workspaceId,positions,{lotId=null,excludeTransferId=null,excludeRentalAgreementId=null,rentalWindow=null,sellableOnly=false,customerId=null,reservationId=null}={}){
 if(!positions.length)return new Map();const requested=JSON.stringify(positions.map(p=>({sku_id:p.skuId,location_id:p.locationId})));
 const rows=(await c.query(`WITH requested AS (SELECT DISTINCT sku_id,location_id FROM jsonb_to_recordset($2::jsonb) AS p(sku_id text,location_id text))
 ${POSITION_SQL}`,[workspaceId,requested,lotId,excludeTransferId,customerId,reservationId])).rows;
 const goodStock=(lotId||sellableOnly)?new Map((await c.query(`WITH requested AS(SELECT DISTINCT sku_id,location_id FROM jsonb_to_recordset($2::jsonb) p(sku_id text,location_id text)) SELECT p.sku_id,p.location_id,CASE i.tracking_mode WHEN 'lot' THEN coalesce((SELECT sum(lb.quantity) FROM lot_balances lb JOIN lots l ON l.workspace_id=lb.workspace_id AND l.id=lb.lot_id WHERE lb.workspace_id=$1 AND l.sku_id=p.sku_id AND lb.location_id=p.location_id AND l.recalled_at IS NULL AND (l.expires_at IS NULL OR l.expires_at::date>=$3::date)),0) WHEN 'serial' THEN (SELECT count(*) FROM serial_units u LEFT JOIN lots l ON l.workspace_id=u.workspace_id AND l.id=u.lot_id WHERE u.workspace_id=$1 AND u.sku_id=p.sku_id AND u.location_id=p.location_id AND u.status='in_stock' AND u.condition='good' AND l.recalled_at IS NULL AND (l.expires_at IS NULL OR l.expires_at::date>=$3::date)) ELSE coalesce(b.on_hand,0) END::text quantity FROM requested p JOIN skus s ON s.workspace_id=$1 AND s.id=p.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id LEFT JOIN balances b ON b.workspace_id=$1 AND b.sku_id=p.sku_id AND b.location_id=p.location_id`,[workspaceId,requested,await require('../lib/business-time').today(c,workspaceId)])).rows.map(r=>[key(r.sku_id,r.location_id),Number(r.quantity)])):new Map();
 const rotation=lotId?new Map((await c.query(`SELECT sku_id,location_id,coalesce(sum(quantity) FILTER(WHERE lot_id=$3),0)::text selected,sum(quantity)::text bound FROM stockchief_runtime.sales_rotation_entries WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) GROUP BY sku_id,location_id`,[workspaceId,[...new Set(positions.map(p=>p.skuId))],lotId])).rows.map(r=>[key(r.sku_id,r.location_id),r])):new Map();
 const rentals=await require('../custody/postgres-bookings').heldMany(c,workspaceId,positions,{excludeAgreementId:excludeRentalAgreementId,rentalWindow}),returns=await require('../operations/postgres-return-holds').heldMany(c,workspaceId,positions,{lotId}),result=new Map();
 for(const row of rows){const full=Number(row.on_hand),onHand=lotId?Number(row.lot_quantity):full,committed=Number(row.committed),identified=rotation.get(key(row.sku_id,row.location_id)),lotCommitted=lotId?Number(identified?.selected||0):0,transferReserved=Number(lotId?row.lot_reserved:row.transfer_quantity),rentalReserved=rentals.get(key(row.sku_id,row.location_id))||0,held=returns.get(key(row.sku_id,row.location_id))||{quantity:0,lotQuantity:0},returnHeld=lotId?held.lotQuantity:held.quantity;if(![full,onHand,committed,transferReserved,rentalReserved,returnHeld].every(v=>{exact.safeNumber(v,{signed:true});return true;}))throw new ValidationError('Stock commitments need an exact quantity review.');
  result.set(key(row.sku_id,row.location_id),row.custody_agreement_id?{onHand:0,committed:0,reserved:0,rentalReserved:0,available:0,protectedCustody:true}:{onHand,committed:lotId?lotCommitted:committed,reserved:exact.safeNumber(exact.add(exact.add(transferReserved,rentalReserved),returnHeld)),rentalReserved,returnHeld,available:Math.max(0,Math.min(exact.safeNumber(exact.subtract(exact.subtract(exact.subtract(exact.subtract(onHand,lotId?lotCommitted:committed),transferReserved),lotId?0:rentalReserved),returnHeld),{signed:true}),exact.safeNumber(exact.subtract(exact.subtract(exact.subtract(exact.subtract(goodStock.get(key(row.sku_id,row.location_id))??full,committed),row.transfer_quantity),rentalReserved),held.quantity),{signed:true})))});
 }return result;
}
async function read(c,workspaceId,skuId,locationId,options={}){return (await readMany(c,workspaceId,[{skuId,locationId}],options)).get(key(skuId,locationId))||{onHand:0,committed:0,reserved:0,rentalReserved:0,available:0};}
async function total(c,workspaceId,{itemId=null}={}){
 const holds=await require('../custody/postgres-bookings').heldMany(c,workspaceId,null),rows=[...holds].map(([key,quantity])=>{const [sku_id,location_id]=JSON.parse(key);return {sku_id,location_id,quantity};});
 // Sum positive owned stock once, then subtract min(stock, combined holds)
 // only at held positions. This equals max(stock-holds,0) at every position
 // without joining four usually empty reservation sources to millions of rows.
 const r=(await c.query(`WITH sales AS (
 SELECT a.sku_id,a.location_id,sum(a.quantity) quantity FROM sales_stock_commitments a
 WHERE a.workspace_id=$1 GROUP BY a.sku_id,a.location_id
 ), transfers AS (
 SELECT l.sku_id,t.source_location_id location_id,sum(CASE WHEN t.status='REQUESTED' THEN l.requested_quantity ELSE l.approved_quantity END) quantity
 FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.workspace_id=l.workspace_id AND t.id=l.transfer_id
 WHERE l.workspace_id=$1 AND t.status IN ('REQUESTED','APPROVED','PICKED') GROUP BY l.sku_id,t.source_location_id
 ), rental_holds AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS r(sku_id text,location_id text,quantity numeric)),
 return_holds AS (${require('../operations/postgres-return-holds').source}),
 active_skus AS MATERIALIZED (
 SELECT s.id FROM skus s WHERE s.workspace_id=$1 AND s.is_active=1 AND ($3::text IS NULL OR s.item_id=$3)
 AND s.item_id IN(SELECT id FROM items WHERE workspace_id=$1 AND is_active=1)
 ), owned_locations AS MATERIALIZED (
 SELECT id FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL
 ), physical AS NOT MATERIALIZED (
 SELECT b.sku_id,b.location_id,b.on_hand FROM balances b WHERE b.workspace_id=$1 AND b.on_hand>0
 AND b.sku_id IN(SELECT id FROM active_skus)
 AND b.location_id IN(SELECT id FROM owned_locations)
 ), held_positions AS MATERIALIZED (
 SELECT sku_id,location_id,coalesce(sum(quantity),0) quantity FROM (
 SELECT sku_id,location_id,quantity FROM sales UNION ALL
 SELECT sku_id,location_id,quantity FROM transfers UNION ALL
 SELECT sku_id,location_id,quantity FROM rental_holds UNION ALL
 SELECT sku_id,location_id,quantity FROM return_holds
 ) holds GROUP BY sku_id,location_id
 )
 SELECT ((SELECT coalesce(sum(on_hand),0) FROM physical)-
 coalesce((SELECT sum(least(b.on_hand,held.quantity)) FROM held_positions held
 CROSS JOIN LATERAL(SELECT b.on_hand FROM balances b WHERE b.workspace_id=$1
 AND b.sku_id=held.sku_id AND b.location_id=held.location_id AND b.on_hand>0
 OFFSET 0) b WHERE held.sku_id IN(SELECT id FROM active_skus)
 AND held.location_id IN(SELECT id FROM owned_locations)),0))::text quantity
 `,[workspaceId,JSON.stringify(rows),itemId])).rows[0];return exact.safeNumber(r.quantity);
}
module.exports={read,readMany,key,total};
