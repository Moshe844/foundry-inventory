'use strict';
// Report exports need the full inventory. List-page badges need only the
// visible items, before stock positions and totals are materialized.
function source({scopeItems=false}={}){
 if(typeof scopeItems!=='boolean')throw new TypeError('Choose a fixed item scope.');
 const selected=scopeItems?'selected_skus AS MATERIALIZED(SELECT id FROM skus WHERE workspace_id=$1 AND item_id=ANY($2::text[])),':'';
 const stockScope=scopeItems?'AND b.sku_id IN(SELECT id FROM selected_skus)':'';
 const policyScope=scopeItems?'JOIN selected_skus selected ON selected.id=p.sku_id':'';
 return `WITH ${selected}stock_positions AS NOT MATERIALIZED(
 SELECT b.sku_id,b.location_id,b.on_hand FROM balances b
 WHERE b.workspace_id=$1 AND b.location_id=ANY(ARRAY(SELECT id FROM locations WHERE workspace_id=$1 AND is_active=1)) ${stockScope}
 ),stock_totals AS MATERIALIZED(SELECT sku_id,sum(on_hand) AS on_hand FROM stock_positions GROUP BY sku_id),
 low_positions AS MATERIALIZED(
 SELECT p.workspace_id,p.sku_id,p.location_id,p.reorder_point,p.target_stock,
 coalesce(CASE WHEN p.location_id IS NULL THEN total.on_hand ELSE stock.on_hand END,0)::numeric AS on_hand
 FROM reorder_policies p ${policyScope}
 LEFT JOIN LATERAL(SELECT b.on_hand FROM balances b WHERE b.workspace_id=p.workspace_id
 AND p.location_id IS NOT NULL AND b.sku_id=p.sku_id AND b.location_id=p.location_id OFFSET 0) stock ON true
 LEFT JOIN stock_totals total ON total.sku_id=p.sku_id
 WHERE p.workspace_id=$1 AND p.reorder_point IS NOT NULL
 AND coalesce(CASE WHEN p.location_id IS NULL THEN total.on_hand ELSE stock.on_hand END,0)<=p.reorder_point)
 SELECT i.id AS record_id,s.code AS sku,concat_ws(' — ',i.name,nullif(s.variant_label,'')) AS product,coalesce(l.name,'Whole business') AS location,
 p.on_hand,p.reorder_point::numeric AS reorder_point,p.target_stock::numeric AS target_stock
 FROM low_positions p JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id LEFT JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id
 WHERE s.is_active=1 AND i.is_active=1 AND (p.location_id IS NULL OR l.is_active=1)`;
}
module.exports={source};
