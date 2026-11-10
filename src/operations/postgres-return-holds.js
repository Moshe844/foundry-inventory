'use strict';
const pending='greatest(rl.quantity_received-rl.quantity_restocked-rl.quantity_scrapped-rl.quantity_repair,0)';
const returnSource=`SELECT rl.sku_id,r.quarantine_location_id AS location_id,sum(${pending}) AS quantity
 FROM customer_return_lines rl JOIN customer_returns r ON r.workspace_id=rl.workspace_id AND r.id=rl.customer_return_id
 WHERE rl.workspace_id=$1 AND r.status<>'CANCELLED' AND ${pending}>0 GROUP BY rl.sku_id,r.quarantine_location_id`;
const source=`SELECT sku_id,location_id,sum(quantity) quantity FROM(${returnSource} UNION ALL SELECT sku_id,location_id,quality_held quantity FROM balances WHERE workspace_id=$1 AND quality_held>0) holds GROUP BY sku_id,location_id`;
const grants=new WeakMap();
function inspectionContext(ctx,returnId){const scoped={...ctx};grants.set(scoped,returnId);return scoped;}
async function heldMany(db,workspaceId,positions,{lotId=null,excludeReturnId=null}={}){
 if(!positions.length)return new Map();const rows=(await db.query(`WITH requested AS(SELECT DISTINCT sku_id,location_id FROM jsonb_to_recordset($2::jsonb) p(sku_id text,location_id text))
 SELECT sku_id,location_id,sum(quantity) quantity,sum(lot_quantity) lot_quantity,sum(quality_quantity) quality_quantity FROM(
 SELECT rl.sku_id,r.quarantine_location_id AS location_id,sum(${pending}) AS quantity,
 sum(CASE WHEN $3::text IS NULL THEN 0 ELSE coalesce((SELECT sum((batch->>'quantity')::numeric) FROM jsonb_array_elements(coalesce(rl.tracking_evidence::jsonb->'receivedBatches','[]')) batch WHERE batch->>'lotId'=$3),0) END) AS lot_quantity,0::numeric quality_quantity
 FROM customer_return_lines rl JOIN customer_returns r ON r.workspace_id=rl.workspace_id AND r.id=rl.customer_return_id
 JOIN requested p ON p.sku_id=rl.sku_id AND p.location_id=r.quarantine_location_id
 WHERE rl.workspace_id=$1 AND r.status<>'CANCELLED' AND ($4::text IS NULL OR r.id<>$4) AND ${pending}>0 GROUP BY rl.sku_id,r.quarantine_location_id
 UNION ALL SELECT b.sku_id,b.location_id,b.quality_held,0,b.quality_held FROM balances b JOIN requested p ON p.sku_id=b.sku_id AND p.location_id=b.location_id WHERE b.workspace_id=$1 AND b.quality_held>0) all_holds GROUP BY sku_id,location_id`,[workspaceId,JSON.stringify(positions.map(p=>({sku_id:p.skuId,location_id:p.locationId}))),lotId,excludeReturnId])).rows;
 return new Map(rows.map(r=>[JSON.stringify([r.sku_id,r.location_id]),{quantity:Number(r.quantity),lotQuantity:Number(r.lot_quantity),qualityQuantity:Number(r.quality_quantity)}]));
}
async function assertCanMove(db,ctx,{skuId,locationId,quantity,lotId=null,serialUnitIds=[]}){
 if(serialUnitIds.length)await db.query('SELECT id FROM serial_units WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 AND id=ANY($4::text[]) ORDER BY id FOR UPDATE',[ctx.workspaceId,skuId,locationId,serialUnitIds]);
 const balance=(await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE',[ctx.workspaceId,skuId,locationId])).rows[0],excludeReturnId=grants.get(ctx)||null,held=(await heldMany(db,ctx.workspaceId,[{skuId,locationId}],{lotId,excludeReturnId})).get(JSON.stringify([skuId,locationId]));
 if(!held?.quantity)return;
 const {ValidationError}=require('../domain/errors'),exact=require('../domain/exact-quantity');
 if(exact.safeNumber(exact.subtract(balance?.on_hand||0,held.quantity),{signed:true})<Number(quantity))throw new ValidationError(held.qualityQuantity?'These units are held for delivery QC. Complete the physical inspection and release before selling, using or moving them.':'These units are waiting for return inspection. Inspect and release them before selling, using or moving them.');
 if(lotId&&held.lotQuantity){const lot=(await db.query('SELECT quantity FROM lot_balances WHERE workspace_id=$1 AND lot_id=$2 AND location_id=$3 FOR UPDATE',[ctx.workspaceId,lotId,locationId])).rows[0];if(exact.safeNumber(exact.subtract(lot?.quantity||0,held.lotQuantity),{signed:true})<Number(quantity))throw new ValidationError('This batch is waiting for return inspection. Choose released stock.');}
 if(serialUnitIds.length&&(await db.query(`SELECT 1 FROM customer_return_lines rl JOIN customer_returns r ON r.workspace_id=rl.workspace_id AND r.id=rl.customer_return_id WHERE rl.workspace_id=$1 AND rl.sku_id=$2 AND r.quarantine_location_id=$3 AND r.status<>'CANCELLED' AND ($5::text IS NULL OR r.id<>$5) AND ${pending}>0 AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(rl.tracking_evidence::jsonb->'receivedBatches','[]')) batch WHERE (batch->'serialUnitIds') ?| $4::text[]) LIMIT 1`,[ctx.workspaceId,skuId,locationId,serialUnitIds,excludeReturnId])).rows.length)throw new ValidationError('A scanned serial number is waiting for return inspection. Choose released stock.');
}
async function heldLots(db,workspaceId,skuId,locationId){const rows=(await db.query(`SELECT batch->>'lotId' AS lot_id,sum((batch->>'quantity')::numeric) AS quantity FROM customer_return_lines rl JOIN customer_returns r ON r.workspace_id=rl.workspace_id AND r.id=rl.customer_return_id CROSS JOIN LATERAL jsonb_array_elements(coalesce(rl.tracking_evidence::jsonb->'receivedBatches','[]')) batch WHERE rl.workspace_id=$1 AND rl.sku_id=$2 AND r.quarantine_location_id=$3 AND r.status<>'CANCELLED' AND ${pending}>0 AND batch->>'lotId' IS NOT NULL GROUP BY batch->>'lotId'`,[workspaceId,skuId,locationId])).rows;return new Map(rows.map(r=>[r.lot_id,Number(r.quantity)]));}
module.exports={source,heldMany,heldLots,assertCanMove,inspectionContext};
