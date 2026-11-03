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
// Filtering counts the entire catalogue. Aggregate active stock once, rather
// than performing a stock sum for every variant during both count and paging.
function filterSource(){return `WITH positions AS MATERIALIZED(
 SELECT b.sku_id,b.location_id,b.on_hand FROM balances b JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id
 WHERE b.workspace_id=$1 AND l.is_active=1
 ), policies AS MATERIALIZED(SELECT p.sku_id,p.location_id,p.reorder_point FROM reorder_policies p
 WHERE p.workspace_id=$1 AND p.reorder_point IS NOT NULL AND(p.location_id IS NULL OR EXISTS(
 SELECT 1 FROM locations l WHERE l.workspace_id=$1 AND l.id=p.location_id AND l.is_active=1)))
 SELECT sku_id FROM(SELECT sku_id,reorder_point,0::numeric on_hand FROM policies WHERE location_id IS NULL
 UNION ALL SELECT sku_id,NULL::numeric,on_hand FROM positions WHERE EXISTS(SELECT 1 FROM policies WHERE location_id IS NULL)) whole_stock
 GROUP BY sku_id HAVING min(reorder_point) IS NOT NULL AND sum(on_hand)<=min(reorder_point)
 UNION SELECT sku_id FROM(SELECT sku_id,location_id,reorder_point,0::numeric on_hand FROM policies WHERE location_id IS NOT NULL
 UNION ALL SELECT sku_id,location_id,NULL::numeric,on_hand FROM positions WHERE EXISTS(SELECT 1 FROM policies WHERE location_id IS NOT NULL)) site_stock
 GROUP BY sku_id,location_id HAVING min(reorder_point) IS NOT NULL AND sum(on_hand)<=min(reorder_point)`;}
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
