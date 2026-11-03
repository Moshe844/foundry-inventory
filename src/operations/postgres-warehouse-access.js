'use strict';
const {AuthorizationError}=require('../domain/errors');
async function scope(db,ctx){
 const actor=(await db.query('SELECT role,warehouse_location_ids FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!actor)throw new AuthorizationError('Your inventory membership could not be verified.');
 return actor.role==='owner'?null:actor.warehouse_location_ids;
}
async function locations(db,workspaceId,roots){
 if(roots===null)return (await db.query('SELECT id,name,kind FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL ORDER BY name,id',[workspaceId])).rows;
 return (await db.query(`WITH RECURSIVE permitted AS (
 SELECT id,name,kind,ARRAY[id] path FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[]) AND is_active=1 AND custody_agreement_id IS NULL
 UNION ALL SELECT l.id,l.name,l.kind,p.path||l.id FROM locations l JOIN permitted p ON l.parent_location_id=p.id
 WHERE l.workspace_id=$1 AND l.is_active=1 AND l.custody_agreement_id IS NULL AND NOT l.id=ANY(p.path) AND cardinality(p.path)<64)
 SELECT DISTINCT id,name,kind FROM permitted ORDER BY name,id`,[workspaceId,roots])).rows;
}
async function assertLocations(db,ctx,ids){
 const roots=await scope(db,ctx);if(roots===null)return;
 const allowed=new Set((await locations(db,ctx.workspaceId,roots)).map(l=>l.id));
 if(!ids.length||ids.some(id=>!allowed.has(id)))throw new AuthorizationError('This location is outside your assigned warehouses. Ask your inventory owner to update your access.');
}
async function assertInventoryWide(db,ctx){if(await scope(db,ctx)!==null)throw new AuthorizationError('Your access is limited to assigned warehouses. Use Warehouse stock, or ask your inventory owner for inventory-wide access.');}
module.exports={scope,locations,assertLocations,assertInventoryWide};
