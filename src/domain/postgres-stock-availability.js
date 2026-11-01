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
 LEFT JOIN LATERAL(SELECT sum(a.quantity) quantity FROM sales_order_allocations a
  JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id
  JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
  WHERE a.workspace_id=$1 AND l.sku_id=s.id AND a.location_id=loc.id AND o.status NOT IN ('CANCELLED','FULFILLED'))sales ON true
 LEFT JOIN LATERAL(SELECT sum(CASE WHEN t.status='REQUESTED' THEN l.requested_quantity ELSE l.approved_quantity END) quantity,
  sum(CASE WHEN t.status='REQUESTED' THEN l.requested_quantity ELSE l.approved_quantity END) FILTER(WHERE $3::text IS NULL OR l.lot_id=$3) lot_quantity
  FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.workspace_id=l.workspace_id AND t.id=l.transfer_id
  WHERE l.workspace_id=$1 AND l.sku_id=s.id AND t.source_location_id=loc.id AND t.status IN ('REQUESTED','APPROVED','PICKED')
   AND ($4::text IS NULL OR t.id<>$4))transfers ON true`;
async function readMany(c,workspaceId,positions,{lotId=null,excludeTransferId=null,excludeRentalAgreementId=null,rentalWindow=null}={}){
 if(!positions.length)return new Map();const requested=JSON.stringify(positions.map(p=>({sku_id:p.skuId,location_id:p.locationId})));
 const rows=(await c.query(`WITH requested AS (SELECT DISTINCT sku_id,location_id FROM jsonb_to_recordset($2::jsonb) AS p(sku_id text,location_id text))
 ${POSITION_SQL}`,[workspaceId,requested,lotId,excludeTransferId])).rows;
 const rentals=await require('../custody/postgres-bookings').heldMany(c,workspaceId,positions,{excludeAgreementId:excludeRentalAgreementId,rentalWindow}),result=new Map();
 for(const row of rows){const full=Number(row.on_hand),onHand=lotId?Number(row.lot_quantity):full,committed=Number(row.committed),transferReserved=Number(lotId?row.lot_reserved:row.transfer_quantity),rentalReserved=rentals.get(key(row.sku_id,row.location_id))||0;if(![full,onHand,committed,transferReserved,rentalReserved].every(v=>{exact.safeNumber(v,{signed:true});return true;}))throw new ValidationError('Stock commitments need an exact quantity review.');
  result.set(key(row.sku_id,row.location_id),row.custody_agreement_id?{onHand:0,committed:0,reserved:0,rentalReserved:0,available:0,protectedCustody:true}:{onHand,committed:lotId?0:committed,reserved:exact.safeNumber(exact.add(transferReserved,rentalReserved)),rentalReserved,available:Math.max(0,Math.min(exact.safeNumber(exact.subtract(exact.subtract(exact.subtract(onHand,lotId?0:committed),transferReserved),lotId?0:rentalReserved),{signed:true}),exact.safeNumber(exact.subtract(exact.subtract(exact.subtract(full,committed),row.transfer_quantity),rentalReserved),{signed:true})))});
 }return result;
}
async function read(c,workspaceId,skuId,locationId,options={}){return (await readMany(c,workspaceId,[{skuId,locationId}],options)).get(key(skuId,locationId))||{onHand:0,committed:0,reserved:0,rentalReserved:0,available:0};}
async function total(c,workspaceId){
 const holds=await require('../custody/postgres-bookings').heldMany(c,workspaceId,null),rows=[...holds].map(([key,quantity])=>{const [sku_id,location_id]=JSON.parse(key);return {sku_id,location_id,quantity};});
 // Aggregate each commitment source once. Reusing the point lookup here ran
 // its correlated sales/transfer subqueries for every stock position.
 const r=(await c.query(`WITH sales AS (
 SELECT l.sku_id,a.location_id,sum(a.quantity) quantity FROM sales_order_allocations a
 JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id
 JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
 WHERE a.workspace_id=$1 AND o.status NOT IN ('CANCELLED','FULFILLED') GROUP BY l.sku_id,a.location_id
 ), transfers AS (
 SELECT l.sku_id,t.source_location_id location_id,sum(CASE WHEN t.status='REQUESTED' THEN l.requested_quantity ELSE l.approved_quantity END) quantity
 FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.workspace_id=l.workspace_id AND t.id=l.transfer_id
 WHERE l.workspace_id=$1 AND t.status IN ('REQUESTED','APPROVED','PICKED') GROUP BY l.sku_id,t.source_location_id
 ), rental_holds AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS r(sku_id text,location_id text,quantity numeric)),
 active_skus AS MATERIALIZED (
 SELECT s.id FROM skus s WHERE s.workspace_id=$1 AND s.is_active=1
 AND s.item_id IN(SELECT id FROM items WHERE workspace_id=$1 AND is_active=1)
 ), physical AS MATERIALIZED (
 SELECT b.sku_id,b.location_id,b.on_hand FROM balances b WHERE b.workspace_id=$1 AND b.on_hand>0
 AND b.sku_id IN(SELECT id FROM active_skus)
 AND b.location_id IN(SELECT id FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL)
 )
 SELECT coalesce(sum(greatest(b.on_hand-coalesce(sales.quantity,0)-coalesce(transfers.quantity,0)-coalesce(r.quantity,0),0)),0)::text quantity
 FROM physical b
 LEFT JOIN sales ON sales.sku_id=b.sku_id AND sales.location_id=b.location_id
 LEFT JOIN transfers ON transfers.sku_id=b.sku_id AND transfers.location_id=b.location_id
 LEFT JOIN rental_holds r ON r.sku_id=b.sku_id AND r.location_id=b.location_id
 `,[workspaceId,JSON.stringify(rows)])).rows[0];return exact.safeNumber(r.quantity);
}
module.exports={read,readMany,key,total};
