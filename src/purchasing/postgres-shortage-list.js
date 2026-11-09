'use strict';
const {ValidationError}=require('../domain/errors');
// SKUs whose stock is at or below their reorder point. One join over the policies and
// their own stock rows, cached per business until stock or settings change.
function atOrBelow(db,workspaceId,q){return require('../lib/versioned-read-model').read(db,workspaceId,['reorder-at-or-below',q],async()=>(await db.query(`WITH low AS MATERIALIZED(
  SELECT p.sku_id FROM reorder_policies p LEFT JOIN balances b ON b.workspace_id=p.workspace_id AND b.sku_id=p.sku_id AND b.location_id=p.location_id
  WHERE p.workspace_id=$1 AND p.location_id IS NOT NULL AND p.reorder_point IS NOT NULL AND coalesce(b.on_hand,0)<=p.reorder_point
   AND p.location_id=ANY(ARRAY(SELECT id FROM locations WHERE workspace_id=$1 AND is_active=1))
  UNION
  SELECT p.sku_id FROM reorder_policies p WHERE p.workspace_id=$1 AND p.location_id IS NULL AND p.reorder_point IS NOT NULL
   AND (SELECT coalesce(sum(b.on_hand),0) FROM balances b WHERE b.workspace_id=$1 AND b.sku_id=p.sku_id
    AND b.location_id=ANY(ARRAY(SELECT id FROM locations WHERE workspace_id=$1 AND is_active=1)))<=p.reorder_point)
  SELECT s.id,count(*) OVER()::int AS total FROM low JOIN skus s ON s.workspace_id=$1 AND s.id=low.sku_id JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
  WHERE s.is_active=1 AND i.is_active=1 AND ($2='' OR i.name ILIKE '%'||$2||'%' OR s.code ILIKE '%'||$2||'%' OR s.variant_label ILIKE '%'||$2||'%')
  ORDER BY s.id LIMIT 100`,[workspaceId,q])).rows,{domain:'business'});}
async function read(db,workspaceId,{afterSkuId=null,q=''}={}){
 q=String(q||'').trim().slice(0,120);if(afterSkuId!==null&&(typeof afterSkuId!=='string'||afterSkuId.length>160))throw new ValidationError('Choose a valid purchasing page.');
 // Walk the catalogue in SKU order and stop at the page: the fenced subquery keeps
 // that order. Joined first, the planner expected two SKUs per product and
 // tested and sorted every SKU (52,574 of them) to show 51.
 const values=[workspaceId];if(afterSkuId!==null)values.push(afterSkuId);const after=afterSkuId!==null?' AND id>$2':'';
 let search='';if(q){values.push(q);const n=values.length;search=` AND (i.name ILIKE '%'||$${n}||'%' OR s.code ILIKE '%'||$${n}||'%' OR s.variant_label ILIKE '%'||$${n}||'%')`;}
 const selected=(await db.query(`SELECT s.id FROM (SELECT id,item_id,workspace_id,code,variant_label FROM skus WHERE workspace_id=$1 AND is_active=1${after} ORDER BY id OFFSET 0) s
 WHERE EXISTS(SELECT 1 FROM items i WHERE i.id=s.item_id AND i.workspace_id=s.workspace_id AND i.is_active=1${search})
 AND (EXISTS(SELECT 1 FROM reorder_policies p WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id)
 OR EXISTS(SELECT 1 FROM movements m WHERE m.workspace_id=s.workspace_id AND m.sku_id=s.id AND m.operation='issue' AND m.quantity_delta<0 AND m.occurred_at::timestamptz>=now()-interval '90 days' GROUP BY m.sku_id HAVING count(*)>=2))
 ORDER BY s.id LIMIT 51`,values)).rows,paged=selected.slice(0,50).map(r=>r.id);
 // The first page leads with SKUs already at or below their reorder point, wherever they sit in a
 // large catalogue, so What to order is never empty just because the empty SKUs come later.
 const urgent=afterSkuId===null?await atOrBelow(db,workspaceId,q):[],ids=[...new Set([...urgent.map(r=>r.id),...paged])];
 const positions=ids.length?await require('../forecasting/postgres-planning-service').position(db,workspaceId,{onlySkuIds:ids}):[],shortages=positions.filter(p=>p.shortage),links=ids.length?(await db.query(`SELECT DISTINCT ON(si.sku_id) si.sku_id,s.name AS supplier_name FROM supplier_items si JOIN suppliers s ON s.workspace_id=si.workspace_id AND s.id=si.supplier_id WHERE si.workspace_id=$1 AND si.sku_id=ANY($2::text[]) AND si.is_active=1 AND s.status='active' ORDER BY si.sku_id,si.is_preferred DESC,s.name,si.id`,[workspaceId,ids])).rows:[];
 const rows=shortages.map(p=>({...p,displayName:p.item_name+(p.variant_label?' — '+p.variant_label:''),supplierName:links.find(l=>l.sku_id===p.sku_id)?.supplier_name||null,needed:require('./replenishment-decision').requiredUnits(p)}));
 const totals=(await db.query('SELECT count(*)::int AS n FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1',[workspaceId])).rows[0];
 return {rows,q,atOrBelowTotal:urgent[0]?.total||0,scanned:ids.length,hasMore:selected.length>50,nextAfterSkuId:paged.at(-1)||null,totalSkus:Number(totals.n)};
}
module.exports={read};
