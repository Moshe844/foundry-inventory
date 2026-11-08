'use strict';
// A file without reorder points still has to feed "What to order". Every SKU
// this import placed somewhere, and that has no reorder point there yet, gets
// the plainest rule the business's own file supports: tell me when it runs out
// (reorder point 0), and refill to the quantity the file gave it. A SKU the file
// listed at zero refills to the usual quantity of its own product's other
// variants, otherwise to the usual quantity across the file. Nothing is
// invented when the file holds no stock at all, and an owner's own reorder
// point, from this file or set earlier, is never changed.
//
// Planner-proof on purpose: right after a large import the policy table's
// statistics are stale, so the rows are read once, worked out here, and written
// in bounded pages whose duplicates the unique policy index skips.
const {nowIso}=require('../lib/util');
const PAGE=5000;
function median(values){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor((sorted.length-1)/2)];}
async function apply(client,ctx,importId){
 const rows=(await client.query(`SELECT DISTINCT ON (sku_id,location_id) sku_id,location_id,item_id,quantity::float8 AS quantity
  FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status='IMPORTED' AND sku_id IS NOT NULL AND location_id IS NOT NULL
  ORDER BY sku_id,location_id,row_number DESC`,[ctx.workspaceId,importId])).rows;
 if(!rows.length)return 0;
 // A rule with no location covers every location; leave those SKUs alone.
 const everywhere=new Set((await client.query('SELECT sku_id FROM reorder_policies WHERE workspace_id=$1 AND location_id IS NULL',[ctx.workspaceId])).rows.map(r=>r.sku_id));
 const stocked=rows.filter(r=>r.quantity>0),byProduct=new Map();
 for(const r of stocked){if(!byProduct.has(r.item_id))byProduct.set(r.item_id,[]);byProduct.get(r.item_id).push(r.quantity);}
 const usual=median(stocked.map(r=>r.quantity)),usualFor=new Map([...byProduct].map(([item,values])=>[item,median(values)]));
 const at=nowIso(),policies=[];
 for(const r of rows){if(everywhere.has(r.sku_id))continue;const target=r.quantity>0?r.quantity:usualFor.get(r.item_id)??usual;if(!(target>0))continue;
  policies.push({id:'rpol_'+require('node:crypto').createHash('sha256').update(importId+':'+r.sku_id+':'+r.location_id).digest('hex').slice(0,24),sku_id:r.sku_id,location_id:r.location_id,target});}
 let created=0;
 for(let start=0;start<policies.length;start+=PAGE)created+=(await client.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,notes,created_at,updated_at)
  SELECT x.id,$1,x.sku_id,x.location_id,0,x.target,0,'manual','Set when this SKU was imported: reorder when it runs out. Change it any time.',$2,$2
  FROM jsonb_to_recordset($3::jsonb) AS x(id text,sku_id text,location_id text,target numeric)
  ON CONFLICT DO NOTHING`,[ctx.workspaceId,at,JSON.stringify(policies.slice(start,start+PAGE))])).rowCount;
 return created;
}
module.exports={apply};
