'use strict';

const summary='Scores warehouse suppliers from placed orders, actual receiving dates and quantities, comparable PO prices and recorded invoice disputes. Future deliveries are excluded from fill rates. Unknown rates are left blank.';

async function review(db,ctx,{filter='',page=1,today}){
  const {rows}=await db.query(`WITH supplier_scope AS MATERIALIZED (
    SELECT id,name FROM suppliers WHERE workspace_id=$1 AND status='active'
      AND ($2='' OR lower(name)=lower($2))
  ), purchases AS MATERIALIZED (
    SELECT p.id,p.supplier_id,p.currency,p.expected_date,p.ordered_at,p.status
    FROM purchase_orders p JOIN supplier_scope s ON s.id=p.supplier_id
    WHERE p.workspace_id=$1 AND p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')
      AND coalesce(to_jsonb(p)->>'delivery_kind','WAREHOUSE')='WAREHOUSE'
  ), lines AS MATERIALIZED (
    SELECT p.*,l.id AS line_id,l.sku_id,l.quantity_units,l.quantity_received_units,
      l.secondary_quantity_ordered,l.secondary_quantity_received,l.unit_cost,l.units_per_purchase_unit,l.purchase_unit
    FROM purchases p JOIN purchase_order_lines l ON l.workspace_id=$1 AND l.purchase_order_id=p.id
    WHERE l.quantity_units>0
  ), receipt_running AS (
    SELECT l.id AS receipt_line,x.line_id,r.received_at::timestamptz AS at,l.over_by_units,
      sum(l.quantity_units) OVER by_line AS received,
      sum(coalesce(l.secondary_quantity,0)) OVER by_line AS measured_received
    FROM lines x JOIN purchase_order_receipt_lines l ON l.workspace_id=$1 AND l.purchase_order_line_id=x.line_id
    JOIN purchase_order_receipts r ON r.workspace_id=l.workspace_id AND r.id=l.receipt_id AND r.purchase_order_id=x.id
    WINDOW by_line AS (PARTITION BY x.line_id ORDER BY r.received_at::timestamptz,r.id,l.id ROWS UNBOUNDED PRECEDING)
  ), receipt_line AS (
    SELECT x.id,x.line_id,min(r.at) FILTER(WHERE r.received>=x.quantity_units AND
      (x.secondary_quantity_ordered IS NULL OR r.measured_received>=x.secondary_quantity_ordered)) AS completed_at,
      coalesce(bool_or(r.over_by_units>0),false) AS overage,
      coalesce(bool_or(q.status='FAILED'),false) AS failed_inspection
    FROM lines x LEFT JOIN receipt_running r ON r.line_id=x.line_id
    LEFT JOIN stockchief_runtime.agent_quality_holds q ON q.workspace_id=$1 AND q.receipt_line_id=r.receipt_line
    GROUP BY x.id,x.line_id
  ), local_zone AS (
    SELECT coalesce(w.time_zone,a.time_zone,'UTC') AS tz FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1
  ), order_receipt AS (
    SELECT p.id,p.supplier_id,p.expected_date,p.status,
      CASE WHEN bool_and(l.completed_at IS NOT NULL) THEN (max(l.completed_at) AT TIME ZONE z.tz)::date END AS completed_on,
      coalesce(bool_or(l.overage),false) AS overage,coalesce(bool_or(l.failed_inspection),false) AS failed_inspection
    FROM purchases p CROSS JOIN local_zone z LEFT JOIN receipt_line l ON l.id=p.id
    GROUP BY p.id,p.supplier_id,p.expected_date,p.status,z.tz
  ), delivery AS (
    SELECT supplier_id,count(*) AS orders,count(completed_on) FILTER(WHERE expected_date IS NOT NULL) AS dated_completions,
      round(100*avg((completed_on<=expected_date::date)::int) FILTER(WHERE completed_on IS NOT NULL AND expected_date IS NOT NULL),1) AS on_time,
      count(*) FILTER(WHERE expected_date::date<$3::date AND completed_on IS NULL) AS overdue_open,
      count(*) FILTER(WHERE overage) AS over_receipts,count(*) FILTER(WHERE failed_inspection) AS failed_inspections
    FROM order_receipt GROUP BY supplier_id
  ), fill AS (
    SELECT supplier_id,count(*) FILTER(WHERE status='RECEIVED' OR expected_date::date<=$3::date) AS due_lines,
      round(100*avg(least(quantity_received_units::numeric/quantity_units,1))
        FILTER(WHERE status='RECEIVED' OR expected_date::date<=$3::date),1) AS filled,
      round(100*avg(least(secondary_quantity_received/nullif(secondary_quantity_ordered,0),1))
        FILTER(WHERE secondary_quantity_ordered>0 AND (status='RECEIVED' OR expected_date::date<=$3::date)),1) AS measured_fill
    FROM lines GROUP BY supplier_id
  ), order_prices AS (
    SELECT supplier_id,sku_id,currency,units_per_purchase_unit,purchase_unit,(secondary_quantity_ordered IS NOT NULL) measured,
      id,ordered_at,min(unit_cost) AS unit_cost
    FROM lines WHERE unit_cost IS NOT NULL AND ordered_at IS NOT NULL
    GROUP BY supplier_id,sku_id,currency,units_per_purchase_unit,purchase_unit,measured,id,ordered_at
    HAVING min(unit_cost)=max(unit_cost)
  ), price_changes AS (
    SELECT supplier_id,unit_cost,lag(unit_cost) OVER(PARTITION BY supplier_id,sku_id,currency,units_per_purchase_unit,purchase_unit,measured
      ORDER BY ordered_at::timestamptz,id) AS previous FROM order_prices
  ), price_stats AS (
    SELECT supplier_id,count(previous) AS comparisons,count(*) FILTER(WHERE unit_cost>previous) AS increases,
      count(*) FILTER(WHERE unit_cost<previous) AS decreases FROM price_changes GROUP BY supplier_id
  ), bills AS (
    SELECT b.supplier_id,count(*) AS checked_bills,count(*) FILTER(WHERE b.status='DISPUTED' OR b.match_status='EXCEPTION') AS errors,
      count(*) FILTER(WHERE b.status='DISPUTED') AS disputed
    FROM accounting_supplier_bills b JOIN supplier_scope s ON s.id=b.supplier_id
    WHERE b.workspace_id=$1 AND b.status NOT IN ('DRAFT','VOID') AND b.match_status IN ('MATCHED','WITHIN_TOLERANCE','EXCEPTION')
    GROUP BY b.supplier_id
  )
  SELECT s.id,s.name,coalesce(d.orders,0) AS orders,d.on_time,coalesce(d.dated_completions,0) AS dated_completions,
    coalesce(d.overdue_open,0) AS overdue_open,coalesce(f.due_lines,0) AS due_lines,f.filled,f.measured_fill,
    coalesce(d.over_receipts,0) AS over_receipts,coalesce(d.failed_inspections,0) AS failed_inspections,
    coalesce(p.comparisons,0) AS comparisons,coalesce(p.increases,0) AS increases,coalesce(p.decreases,0) AS decreases,
    coalesce(b.checked_bills,0) AS checked_bills,coalesce(b.errors,0) AS errors,coalesce(b.disputed,0) AS disputed,
    round(100*(b.checked_bills-b.errors)::numeric/nullif(b.checked_bills,0),1) AS clean_bills
  FROM supplier_scope s LEFT JOIN delivery d ON d.supplier_id=s.id LEFT JOIN fill f ON f.supplier_id=s.id
  LEFT JOIN price_stats p ON p.supplier_id=s.id LEFT JOIN bills b ON b.supplier_id=s.id
  ORDER BY (coalesce(d.orders,0)>0 OR coalesce(b.checked_bills,0)>0) DESC, s.name,s.id LIMIT 101 OFFSET $4`,
  [ctx.workspaceId,filter,today,(page-1)*100]);
  return {rows:rows.slice(0,100).map(row=>{
    const factors=[row.on_time,row.filled,row.clean_bills].filter(value=>value!=null).map(Number);
    const score=factors.length>=2?Math.round(factors.reduce((a,b)=>a+b,0)/factors.length):null;
    return {Supplier:row.name,'Reliability score':score,'Placed orders':row.orders,'On time %':row.on_time,
      'Dated completed orders':row.dated_completions,'Overdue open orders':row.overdue_open,'Filled %':row.filled,
      'Due lines assessed':row.due_lines,'Measured fill %':row.measured_fill,'Comparable prices':row.comparisons,
      'Price increases':row.increases,'Price decreases':row.decreases,'Disputed bills':row.disputed,
      'Matched bills reviewed':row.checked_bills,'Bill errors':row.errors,'Orders with over-receipts':row.over_receipts,
      'Orders with failed inspection':row.failed_inspections,link:'/suppliers/'+row.id};
  }),more:rows.length>100,summary:summary+' The reliability score averages the available on-time, line fill and bill accuracy rates when at least two are known.'};
}

module.exports={review};
