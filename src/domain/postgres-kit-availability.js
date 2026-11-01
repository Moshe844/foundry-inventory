'use strict';
const exact=require('./exact-quantity');
async function read(db,workspaceId,skuIds){
 const kitIds=(await db.query("SELECT DISTINCT kit_sku_id FROM kit_components WHERE workspace_id=$1 AND kit_sku_id=ANY($2::text[]) AND stock_basis='components'",[workspaceId,skuIds])).rows.map(r=>r.kit_sku_id),result=new Map();
 if(!kitIds.length)return result;
 const recipes=new Map();for(const id of kitIds){try{recipes.set(id,await require('./postgres-kit-service').explode(db,workspaceId,id));}catch(error){if(!(error instanceof require('./errors').ValidationError))throw error;result.set(id,{buildable:0,locations:[],reason:error.message});}}
 if(!recipes.size)return result;
 const componentIds=[...new Set([...recipes.values()].flat().map(p=>p.skuId))],byPosition=await stock(db,workspaceId,componentIds),totals=new Map(),locations=[...new Set([...byPosition.keys()].map(key=>JSON.parse(key)[1]))];
 for(const [key,quantity]of byPosition){const skuId=JSON.parse(key)[0];totals.set(skuId,exact.safeNumber(exact.add(totals.get(skuId)||0,quantity)));}
 const whole=(stock,parts)=>Math.max(0,Math.min(...parts.map(p=>Math.floor((stock(p.skuId)+1e-9)/Number(p.quantity)))));
 for(const [id,parts]of recipes)result.set(id,{buildable:whole(sku=>totals.get(sku)||0,parts),locations:locations.map(locationId=>({locationId,buildable:whole(sku=>byPosition.get(JSON.stringify([sku,locationId]))||0,parts)})).filter(p=>p.buildable>0)});
 return result;
}
async function stock(db,workspaceId,componentIds){
 if(!componentIds.length)return new Map();const today=await require('../lib/business-time').today(db,workspaceId);
 const positions=(await db.query(`SELECT b.sku_id,b.location_id,b.on_hand,
 CASE WHEN i.tracking_mode='lot' THEN coalesce((SELECT sum(lb.quantity) FROM lot_balances lb JOIN lots l ON l.workspace_id=lb.workspace_id AND l.id=lb.lot_id WHERE lb.workspace_id=b.workspace_id AND l.sku_id=b.sku_id AND lb.location_id=b.location_id AND (l.expires_at IS NULL OR l.expires_at::date>=$3::date)),0)
 WHEN i.tracking_mode='serial' THEN (SELECT count(*) FROM serial_units u WHERE u.workspace_id=b.workspace_id AND u.sku_id=b.sku_id AND u.location_id=b.location_id AND u.status='in_stock') ELSE b.on_hand END AS usable
 FROM balances b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 JOIN locations loc ON loc.workspace_id=b.workspace_id AND loc.id=b.location_id WHERE b.workspace_id=$1 AND b.sku_id=ANY($2::text[]) AND b.on_hand>0 AND loc.is_active=1 AND loc.custody_agreement_id IS NULL`,[workspaceId,componentIds,today])).rows;
 const available=await require('./postgres-stock-availability').readMany(db,workspaceId,positions.map(p=>({skuId:p.sku_id,locationId:p.location_id}))),result=new Map();
 // Commitments must come out of usable stock. Taking min(usable, available)
 // can count expired pieces as replacements for good stock already promised.
 for(const p of positions){const key=JSON.stringify([p.sku_id,p.location_id]),free=available.get(key)?.available||0,unavailable=exact.subtract(p.on_hand,free),usableFree=exact.safeNumber(exact.subtract(p.usable,unavailable),{signed:true});result.set(key,Math.max(0,Math.min(free,usableFree)));}
 return result;
}
module.exports={read,stock};
