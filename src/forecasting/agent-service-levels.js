'use strict';

async function report(db,ctx,{today,filter,page}){
  const {rows}=await db.query(`WITH zone AS (
    SELECT coalesce(w.time_zone,a.time_zone,'UTC') AS tz FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1
  ), supplier_lines AS (
    SELECT 'Supplier' AS kind,p.supplier_id AS party,s.name,p.id AS order_id,l.quantity_units AS ordered,
      least(l.quantity_units,coalesce(sum(received.units),0)) AS fulfilled,
      coalesce(sum(received.units) FILTER(WHERE received.day<=p.expected_date::date),0)>=l.quantity_units AS timely
    FROM purchase_orders p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
    JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
    LEFT JOIN LATERAL (SELECT x.quantity_units AS units,(r.received_at::timestamptz AT TIME ZONE z.tz)::date AS day
      FROM purchase_order_receipt_lines x JOIN purchase_order_receipts r ON r.workspace_id=x.workspace_id AND r.id=x.receipt_id CROSS JOIN zone z
      WHERE x.workspace_id=l.workspace_id AND x.purchase_order_line_id=l.id) received ON true
    WHERE p.workspace_id=$1 AND p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED') AND p.expected_date::date BETWEEN $3::date-90 AND $3::date-1
      AND coalesce(to_jsonb(p)->>'delivery_kind','WAREHOUSE')='WAREHOUSE'
      AND ($2='' OR lower(s.name)=lower($2)) GROUP BY p.id,p.supplier_id,s.name,l.id,l.quantity_units
  ), customer_lines AS (
    SELECT 'Customer' AS kind,o.customer_id AS party,c.name,o.id AS order_id,l.quantity_ordered AS ordered,
      least(l.quantity_ordered,coalesce(sum(parcel.units) FILTER(WHERE parcel.shipped),0)) AS fulfilled,
      coalesce(sum(parcel.units) FILTER(WHERE parcel.day<=o.needed_by::date),0)>=l.quantity_ordered AS timely
    FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id
    LEFT JOIN LATERAL (SELECT x.quantity AS units,h.shipped_at IS NOT NULL AS shipped,
      (coalesce(h.delivered_at,CASE WHEN h.handover IN ('COLLECTED','DELIVERED_BY_US') THEN h.shipped_at END)::timestamptz AT TIME ZONE z.tz)::date AS day
      FROM sales_shipment_lines x JOIN sales_shipments h ON h.workspace_id=x.workspace_id AND h.id=x.shipment_id CROSS JOIN zone z
      WHERE x.workspace_id=l.workspace_id AND x.sales_order_line_id=l.id AND h.status<>'CANCELLED' AND h.customer_return_id IS NULL) parcel ON true
    WHERE o.workspace_id=$1 AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED')
      AND o.needed_by::date BETWEEN $3::date-90 AND $3::date-1 AND ($2='' OR lower(c.name)=lower($2))
    GROUP BY o.id,o.customer_id,c.name,l.id,l.quantity_ordered
  ), orders AS (
    SELECT kind,party,name,order_id,sum(ordered) AS ordered,sum(fulfilled) AS fulfilled,bool_and(timely) AS timely
    FROM (SELECT * FROM supplier_lines UNION ALL SELECT * FROM customer_lines) combined GROUP BY kind,party,name,order_id
  ) SELECT kind AS "Party type",name AS "Name",count(*)::int AS "Due orders",
    sum(ordered) AS "Ordered units",sum(fulfilled) AS "Filled units",round(100.0*sum(fulfilled)/nullif(sum(ordered),0),1) AS "Fill rate %",
    count(*) FILTER(WHERE timely)::int AS "On time in full",round(100.0*avg(timely::int),1) AS "OTIF %"
    FROM orders GROUP BY kind,party,name ORDER BY kind,name,party LIMIT 101 OFFSET $4`,[ctx.workspaceId,filter,today,(page-1)*100]);
  const projection=(await db.query(`SELECT count(*)::int AS n,round(avg(absolute_error)::numeric,2) AS error
    FROM forecast_outcomes WHERE workspace_id=$1 AND comparable=1 AND absolute_error IS NOT NULL
    AND scored_at::timestamptz >= ($2::date-90)::timestamp AT TIME ZONE $3 AND scored_at::timestamptz < $2::date::timestamp AT TIME ZONE $3`,
    [ctx.workspaceId,today,(await require('../lib/business-time').forWorkspace(db,ctx.workspaceId)).timeZone])).rows[0];
  const forecast=projection.n?'Across '+projection.n+' comparable SKU forecast'+(projection.n===1?'':'s')+', the mean absolute error was '+projection.error+' units.':'No comparable SKU forecast was scored in this period.';
  return {rows:rows.slice(0,100),more:rows.length>100,summary:'Orders due in the previous 90 completed days. Fill rate measures units shipped to customers or received into your warehouses against units ordered. OTIF counts orders for which every line arrived by the promised date. Orders without a promise are excluded. '+forecast};
}
module.exports={report};
