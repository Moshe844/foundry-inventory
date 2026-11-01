'use strict';

// A component reservation is expressed in component units. Convert every
// component back to whole kits before showing an order's committed quantity.
async function load(db,workspaceId,orderId){
 const rows=(await db.query(`SELECT c.*,s.code,s.variant_label,i.name AS item_name,i.tracking_mode,i.secondary_unit_label,
  coalesce((SELECT json_agg(json_build_object('id',a.id,'location_id',a.location_id,'location_name',l.name,'quantity',a.quantity) ORDER BY a.location_id)
   FROM sales_order_kit_allocations a JOIN locations l ON l.workspace_id=a.workspace_id AND l.id=a.location_id
   WHERE a.workspace_id=c.workspace_id AND a.kit_component_id=c.id),'[]') allocations
  FROM sales_order_kit_components c JOIN sales_order_lines ol ON ol.workspace_id=c.workspace_id AND ol.id=c.sales_order_line_id
  JOIN skus s ON s.workspace_id=c.workspace_id AND s.id=c.component_sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  WHERE c.workspace_id=$1 AND ol.sales_order_id=$2 ORDER BY c.sales_order_line_id,c.component_sku_id`,[workspaceId,orderId])).rows;
 const byLine=new Map();
 for(const row of rows){if(!byLine.has(row.sales_order_line_id))byLine.set(row.sales_order_line_id,[]);byLine.get(row.sales_order_line_id).push({...row,displayName:row.item_name+(row.variant_label?' — '+row.variant_label:''),allocations:row.allocations.map(a=>({...a,quantity:Number(a.quantity)}))});}
 return byLine;
}
function ready(components){return components.length?Math.max(0,Math.min(...components.map(c=>Math.floor((c.allocations.reduce((n,a)=>n+a.quantity,0)+1e-9)/Number(c.quantity_per_kit))))):0;}
module.exports={load,ready};
