'use strict';
// How many items are at or below their reorder point: the one number Buy, the
// Reports card and the low-stock report headline all show. An item is a
// product variant (SKU); one that is low in three warehouses is one item.
//
// Same definition as low-stock-source.js: a warehouse rule compares that
// active warehouse's stock (none recorded counts as zero) with its reorder
// point; a whole-business rule compares stock across active warehouses.
// Archived variants and products are not counted.
//
// Written as one pass over the rules and the stock index, with the (usually
// few) archived variants subtracted rather than every low variant looked up:
// 0.5 s instead of 2.6-3.9 s on a 52,000-variant, 210,000-rule business.
const QUERY=`WITH active AS MATERIALIZED (SELECT id FROM locations WHERE workspace_id=$1 AND is_active=1),
 local AS MATERIALIZED (SELECT p.sku_id,p.location_id FROM reorder_policies p JOIN active a ON a.id=p.location_id
   LEFT JOIN balances b ON b.workspace_id=$1 AND b.location_id=p.location_id AND b.sku_id=p.sku_id
   WHERE p.workspace_id=$1 AND p.reorder_point IS NOT NULL AND coalesce(b.on_hand,0)<=p.reorder_point),
 whole AS MATERIALIZED (SELECT p.sku_id,NULL::text AS location_id FROM reorder_policies p
   WHERE p.workspace_id=$1 AND coalesce(p.location_id,'')='' AND p.location_id IS NULL AND p.reorder_point IS NOT NULL
   AND (SELECT coalesce(sum(b.on_hand),0) FROM balances b WHERE b.workspace_id=$1 AND b.sku_id=p.sku_id
     AND b.location_id IN (SELECT id FROM active))<=p.reorder_point),
 archived AS MATERIALIZED (SELECT s.id FROM skus s LEFT JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
   WHERE s.workspace_id=$1 AND (s.is_active<>1 OR i.is_active IS DISTINCT FROM 1)),
 low AS MATERIALIZED (SELECT x.sku_id,x.location_id FROM (SELECT * FROM local UNION ALL SELECT * FROM whole) x
   WHERE NOT EXISTS (SELECT 1 FROM archived WHERE archived.id=x.sku_id))
 SELECT 'total' AS kind,NULL::text AS location_id,NULL::text AS location,(SELECT count(*) FROM (SELECT DISTINCT sku_id FROM low) items)::int AS items
 UNION ALL
 SELECT 'location' AS kind,low.location_id,coalesce(l.name,'Whole business') AS location,count(*)::int AS items
 FROM low LEFT JOIN locations l ON l.workspace_id=$1 AND l.id=low.location_id GROUP BY low.location_id,l.name`;

async function compute(db,workspaceId){
  const rows=(await db.query(QUERY,[workspaceId])).rows;
  const total=rows.find((row)=>row.kind==='total');
  const byLocation=rows.filter((row)=>row.kind==='location').map((row)=>({locationId:row.location_id,location:row.location,items:Number(row.items)}))
    .sort((a,b)=>b.items-a.items||String(a.location).localeCompare(String(b.location)));
  return {items:Number(total?.items||0),byLocation};
}

// Cached with the business's other figures and refreshed when stock or rules change.
function summary(db,workspaceId){
  return require('../lib/versioned-read-model').read(db,workspaceId,['low-stock-items'],()=>module.exports.compute(db,workspaceId),{domain:'business'});
}

module.exports={summary,compute,QUERY};
