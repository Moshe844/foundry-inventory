'use strict';
const {ValidationError}=require('../domain/errors');
async function read(db,workspaceId,{afterSkuId=null,q=''}={}){
 q=String(q||'').trim().slice(0,120);if(afterSkuId!==null&&(typeof afterSkuId!=='string'||afterSkuId.length>160))throw new ValidationError('Choose a valid purchasing page.');
 const selected=(await db.query(`SELECT s.id FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
 WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ($2::text IS NULL OR s.id>$2)
 AND ($3='' OR i.name ILIKE '%'||$3||'%' OR s.code ILIKE '%'||$3||'%' OR s.variant_label ILIKE '%'||$3||'%')
 AND (EXISTS(SELECT 1 FROM reorder_policies p WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id)
 OR EXISTS(SELECT 1 FROM movements m WHERE m.workspace_id=s.workspace_id AND m.sku_id=s.id AND m.operation='issue' AND m.quantity_delta<0 AND m.occurred_at::timestamptz>=now()-interval '90 days' GROUP BY m.sku_id HAVING count(*)>=2))
 ORDER BY s.id LIMIT 51`,[workspaceId,afterSkuId,q])).rows,ids=selected.slice(0,50).map(r=>r.id);
 const positions=ids.length?await require('../forecasting/postgres-planning-service').position(db,workspaceId,{onlySkuIds:ids}):[],shortages=positions.filter(p=>p.shortage),links=ids.length?(await db.query(`SELECT DISTINCT ON(si.sku_id) si.sku_id,s.name AS supplier_name FROM supplier_items si JOIN suppliers s ON s.workspace_id=si.workspace_id AND s.id=si.supplier_id WHERE si.workspace_id=$1 AND si.sku_id=ANY($2::text[]) AND si.is_active=1 AND s.status='active' ORDER BY si.sku_id,si.is_preferred DESC,s.name,si.id`,[workspaceId,ids])).rows:[];
 const rows=shortages.map(p=>({...p,displayName:p.item_name+(p.variant_label?' — '+p.variant_label:''),supplierName:links.find(l=>l.sku_id===p.sku_id)?.supplier_name||null,needed:require('./replenishment-decision').requiredUnits(p)}));
 const totals=(await db.query('SELECT count(*)::int AS n FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1',[workspaceId])).rows[0];
 return {rows,q,scanned:ids.length,hasMore:selected.length>50,nextAfterSkuId:ids.at(-1)||null,totalSkus:Number(totals.n)};
}
module.exports={read};
