'use strict';

const {addDays} = require('../accounting/customer-money');

async function similarProducts(db,ctx,{page,filter,today}){
  const start=addDays(today,-90),latestFirstSale=addDays(today,-30);
  const result=await db.query(`WITH active AS NOT MATERIALIZED (
    SELECT s.workspace_id,s.id,s.code,s.item_id,s.created_at,i.unit_label,i.secondary_unit_label,
      nullif(lower(trim(f.category)),'') category FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      LEFT JOIN catalogue_item_facts f ON f.workspace_id=s.workspace_id AND f.item_id=s.item_id
      WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1
  ), launches AS (
    SELECT * FROM active a WHERE a.created_at::date BETWEEN $3::date AND $4::date AND ($2='' OR lower(a.code)=lower($2))
      AND NOT EXISTS (SELECT 1 FROM sales_order_lines l JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
        WHERE l.workspace_id=$1 AND l.sku_id=a.id AND o.status NOT IN ('DRAFT','CANCELLED') AND o.order_date<=$4::text)
    ORDER BY a.code,a.id LIMIT 26 OFFSET $5
  ), peers AS (
    SELECT DISTINCT p.id,p.item_id,p.code,p.category,p.unit_label,p.secondary_unit_label FROM active p JOIN launches n
      ON (p.item_id=n.item_id OR p.category=n.category) AND p.unit_label=n.unit_label
      AND p.secondary_unit_label IS NOT DISTINCT FROM n.secondary_unit_label AND p.id<>n.id
  ), rates AS (
    SELECT l.sku_id,sum(l.quantity_ordered)/($4::date-min(o.order_date)::date) daily,count(DISTINCT o.order_date) ordered_days
    FROM peers p JOIN sales_order_lines l ON l.workspace_id=$1 AND l.sku_id=p.id
      JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
    WHERE o.status NOT IN ('DRAFT','CANCELLED') AND o.order_date>=$3::text AND o.order_date<$4::text
    GROUP BY l.sku_id HAVING min(o.order_date)<=$6 AND count(DISTINCT o.order_date)>=2
  )
  SELECT n.id,n.code,n.item_id,m.peer_count,m.rate,m.example FROM launches n LEFT JOIN LATERAL (
    SELECT count(*) peer_count,percentile_cont(0.5) WITHIN GROUP(ORDER BY r.daily) rate,min(p.code) example
    FROM peers p JOIN rates r ON r.sku_id=p.id WHERE p.id<>n.id AND p.unit_label=n.unit_label
      AND p.secondary_unit_label IS NOT DISTINCT FROM n.secondary_unit_label AND (p.item_id=n.item_id OR p.category=n.category)
  ) m ON true ORDER BY n.code,n.id`,[ctx.workspaceId,filter,start,today,(page-1)*25,latestFirstSale]);
  return {rows:result.rows.slice(0,25).map(r=>({SKU:r.code,'Comparable SKUs':Number(r.peer_count),'Example comparable SKU':r.example,
    'Estimated units in 30 days':r.rate==null?null:Math.round(Number(r.rate)*3000)/100,link:'/inventory/'+r.item_id})),
    more:result.rows.length>25,summary:'New SKUs created in the last 90 days with no confirmed orders. The estimate uses median daily demand from variants or products in the same category with matching units, at least two order dates and 30 days of observed history. Missing comparisons leave the forecast blank.'};
}

module.exports={similarProducts};
