'use strict';

const path='/autopilot/reviews/customer-health';
const summary='Compares the last 30 local business dates with the preceding 30. The score averages the retained share of shipped orders and, when available, comparable units of each previously shipped product. No comparable earlier purchases leaves the score blank.';

function findings(cutoff){
  return `WITH date_window AS (
    SELECT $3::date AS today,$3::date-29 AS recent_start,$3::date-59 AS prior_start,
      coalesce(w.time_zone,a.time_zone,'UTC') AS tz
    FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1
  ), shipments AS MATERIALIZED (
    SELECT h.id,o.id AS order_id,o.customer_id,
      (h.shipped_at::timestamptz AT TIME ZONE d.tz)::date AS day,
      (h.shipped_at::timestamptz AT TIME ZONE d.tz)::date>=d.recent_start AS recent
    FROM sales_shipments h JOIN sales_orders o ON o.workspace_id=h.workspace_id AND o.id=h.sales_order_id
    CROSS JOIN date_window d
    WHERE h.workspace_id=$1 AND h.status IN ('SHIPPED','DELIVERED') AND h.customer_return_id IS NULL
      AND h.shipped_at IS NOT NULL AND h.shipped_at>=(d.prior_start-2)::text AND h.shipped_at<(d.today+3)::text
      AND (h.shipped_at::timestamptz AT TIME ZONE d.tz)::date BETWEEN d.prior_start AND d.today
      AND (${cutoff}::text IS NULL OR (o.order_date>=${cutoff}::text AND
        (h.shipped_at::timestamptz AT TIME ZONE d.tz)::date>=${cutoff}::date))
  ), order_activity AS (
    SELECT customer_id,count(DISTINCT order_id) FILTER(WHERE NOT recent) AS prior_orders,
      count(DISTINCT order_id) FILTER(WHERE recent) AS recent_orders,max(day) AS last_shipment
    FROM shipments GROUP BY customer_id
  ), quantities AS (
    SELECT h.customer_id,l.sku_id,coalesce(sum(l.quantity) FILTER(WHERE NOT h.recent),0) AS prior_units,
      coalesce(sum(l.quantity) FILTER(WHERE h.recent),0) AS recent_units
    FROM shipments h JOIN sales_shipment_lines l ON l.workspace_id=$1 AND l.shipment_id=h.id
    WHERE l.quantity>0 GROUP BY h.customer_id,l.sku_id
  ), product_activity AS (
    SELECT customer_id,count(*) FILTER(WHERE recent_units<prior_units) AS declining_products,
      avg(least(1,recent_units::numeric/prior_units)) AS retained_products FROM quantities WHERE prior_units>0 GROUP BY customer_id
  ), scores AS (
    SELECT c.id,c.name,c.company,a.last_shipment,coalesce(a.prior_orders,0) AS prior_orders,
      coalesce(a.recent_orders,0) AS recent_orders,coalesce(p.declining_products,0) AS declining_products,
      (${cutoff}::text IS NULL OR ${cutoff}::date<=d.prior_start) AS complete_history,
      least(1,a.recent_orders::numeric/nullif(a.prior_orders,0)) AS retained_orders,p.retained_products
    FROM customers c CROSS JOIN date_window d
    LEFT JOIN order_activity a ON a.customer_id=c.id LEFT JOIN product_activity p ON p.customer_id=c.id
    WHERE c.workspace_id=$1 AND c.record_state='ACTIVE'
      AND ($2='' OR lower(c.name)=lower($2) OR lower(c.company)=lower($2))
  )
  SELECT id,name,company,last_shipment::text,prior_orders,recent_orders,declining_products,
    CASE WHEN complete_history AND prior_orders>0 THEN round(100*(retained_orders+coalesce(retained_products,retained_orders))/2)::int END AS score,
    CASE WHEN NOT complete_history THEN 'Earlier history unavailable'
      WHEN prior_orders=0 AND recent_orders=0 THEN 'No recent shipments'
      WHEN prior_orders=0 THEN 'New activity'
      WHEN recent_orders=0 THEN 'No orders shipped in the recent period'
      WHEN recent_orders<prior_orders OR declining_products>0 THEN 'Buying less'
      WHEN recent_orders>prior_orders THEN 'Buying more' ELSE 'Stable' END AS health,
    complete_history AND prior_orders>0 AND (recent_orders<prior_orders OR declining_products>0) AS declining
  FROM scores`;
}

const sort='ORDER BY declining DESC,score ASC NULLS LAST,name,id';

async function review(db,ctx,{filter='',page=1,today}){
  const cutoff=(await require('../commercial/agent-history').access(db,ctx.workspaceId)).salesFrom;
  const {rows}=await db.query(findings('$4')+' '+sort+' LIMIT 101 OFFSET $5',[ctx.workspaceId,filter,today,cutoff,(page-1)*100]);
  return {rows:rows.slice(0,100).map(row=>({
    Customer:row.name,Company:row.company,Health:row.health,'Activity score':row.score,
    'Prior orders':row.prior_orders,'Recent orders':row.recent_orders,'Products with fewer shipped units':row.declining_products,
    'Last shipment':row.last_shipment,link:'/sales/customers/'+row.id
  })),more:rows.length>100,summary};
}

function notices(cutoff){
  return `SELECT 88,'Customer activity',id,'/sales/customers/'||id,$3::date
    FROM (${findings(cutoff)}) customer_health WHERE declining`;
}

module.exports={path,summary,review,notices};
