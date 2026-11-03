'use strict';
// A grouped catalogue page needs only its displayed products. Do not join the
// inventory-wide report CTEs: their plan can multiply stock-position scans.
async function forItems(db,workspaceId,itemIds){
 if(!Array.isArray(itemIds)||itemIds.length>200)throw new TypeError('Choose a bounded catalogue page.');
 if(!itemIds.length)return [];
 return (await db.query(`WITH selected AS MATERIALIZED(
   SELECT s.id,s.item_id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
   WHERE s.workspace_id=$1 AND s.item_id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1)
 SELECT DISTINCT s.item_id AS record_id FROM selected s
 JOIN reorder_policies p ON p.workspace_id=$1 AND p.sku_id=s.id AND p.reorder_point IS NOT NULL
 LEFT JOIN locations policy_location ON policy_location.workspace_id=$1 AND policy_location.id=p.location_id
 CROSS JOIN LATERAL(SELECT coalesce(sum(b.on_hand),0) quantity FROM balances b
   JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id AND l.is_active=1
   WHERE b.workspace_id=$1 AND b.sku_id=s.id AND(p.location_id IS NULL OR b.location_id=p.location_id)) stock
 WHERE (p.location_id IS NULL OR policy_location.is_active=1) AND stock.quantity<=p.reorder_point`,[workspaceId,itemIds])).rows;
}
module.exports={forItems};
