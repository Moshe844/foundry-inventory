'use strict';
// A grouped catalogue page needs only its displayed products. Do not join the
// inventory-wide report CTEs: their plan can multiply stock-position scans.
function skuCondition(){return `EXISTS(SELECT 1 FROM reorder_policies p WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id
 AND p.reorder_point IS NOT NULL AND(p.location_id IS NULL OR EXISTS(SELECT 1 FROM locations site WHERE site.workspace_id=$1 AND site.id=p.location_id AND site.is_active=1))
 AND(SELECT coalesce(sum(b.on_hand),0) FROM balances b JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id AND l.is_active=1
   WHERE b.workspace_id=$1 AND b.sku_id=s.id AND(p.location_id IS NULL OR b.location_id=p.location_id))<=p.reorder_point)`;}
// A scalar LIMIT keeps the lookup parameterized by product even before fresh
// imports have planner statistics. EXISTS alone can be pulled into a broad join.
function itemCondition(){return `coalesce((SELECT true FROM skus s WHERE s.workspace_id=i.workspace_id
 AND s.item_id=i.id AND s.is_active=1 AND ${skuCondition()} LIMIT 1),false)`;}
// Filtering needs identities across the catalogue, but never a materialized
// copy of every bin. Share the report's exact SKU totals plus pending changes;
// the list callers retain their own active-product and permission predicates.
function filterSource(){return require('./low-stock-source').source({skuIdsOnly:true});}
async function forItems(db,workspaceId,itemIds){
 if(!Array.isArray(itemIds)||itemIds.length>200)throw new TypeError('Choose a bounded catalogue page.');
 if(!itemIds.length)return [];
 return (await db.query(`SELECT i.id AS record_id FROM items i
 WHERE i.workspace_id=$1 AND i.id=ANY($2::text[]) AND i.is_active=1 AND ${itemCondition()}
 ORDER BY i.id`,[workspaceId,itemIds])).rows;
}
async function forSkus(db,workspaceId,skuIds){
 if(!Array.isArray(skuIds)||skuIds.length>200)throw new TypeError('Choose a bounded variant page.');if(!skuIds.length)return [];
 return (await db.query(`SELECT s.id AS sku_id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1 AND ${skuCondition()}`,[workspaceId,skuIds])).rows;
}
module.exports={forItems,forSkus,skuCondition,itemCondition,filterSource};
