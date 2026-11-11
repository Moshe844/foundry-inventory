'use strict';

// Keep denominators and physical return proof separate. One order line may
// have several returns, and one return may contain several order lines.
function comparison(historyFrom) {
  return `WITH fulfilled AS MATERIALIZED (
    SELECT l.workspace_id,l.id,l.sales_order_id,l.sku_id,s.code AS sku,s.item_id,c.id AS customer_id,c.name AS customer,
      lower(btrim(i.unit_label)) AS unit,l.quantity_fulfilled AS shipped
    FROM sales_order_lines l
    JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
    JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE l.workspace_id=$1 AND l.quantity_fulfilled>0
      AND (${historyFrom}::text IS NULL OR o.order_date>=${historyFrom})
  ), returned_lines AS MATERIALIZED (
    SELECT f.id AS order_line_id,r.id AS return_id,r.return_number,rl.quantity_received,
      coalesce((
        SELECT sum(m.quantity_delta)
        FROM movements m
        WHERE m.workspace_id=f.workspace_id AND m.sku_id=f.sku_id AND m.operation='receive'
          AND m.quantity_delta>0 AND m.reference=r.return_number
          AND m.id IN (SELECT jsonb_array_elements_text(rl.receive_movement_ids::jsonb))
      ),0)=rl.quantity_received AS physical
    FROM fulfilled f
    JOIN customer_return_lines rl ON rl.workspace_id=f.workspace_id AND rl.sales_order_line_id=f.id AND rl.sku_id=f.sku_id
    JOIN customer_returns r ON r.workspace_id=rl.workspace_id AND r.id=rl.customer_return_id AND r.sales_order_id=f.sales_order_id
    WHERE rl.quantity_received>0
  ), line_totals AS (
    SELECT order_line_id,sum(quantity_received) AS returned,bool_and(physical) AS verified
    FROM returned_lines GROUP BY order_line_id
  ), subjects AS MATERIALIZED (
    SELECT f.id AS order_line_id,f.unit,f.shipped,coalesce(l.returned,0) AS returned,coalesce(l.verified,true) AS verified,
      subject.kind,subject.entity_id,subject.name,subject.link
    FROM fulfilled f
    LEFT JOIN line_totals l ON l.order_line_id=f.id
    CROSS JOIN LATERAL (VALUES ('SKU',f.sku_id,f.sku,'/inventory/'||f.item_id),
      ('Customer',f.customer_id,f.customer,'/sales/customers/'||f.customer_id)) subject(kind,entity_id,name,link)
  ), receipts AS (
    SELECT s.kind,s.entity_id,s.unit,count(DISTINCT r.return_id)::int AS physical_returns,
      string_agg(DISTINCT r.return_number,', ' ORDER BY r.return_number) AS return_numbers
    FROM subjects s JOIN returned_lines r ON r.order_line_id=s.order_line_id
    WHERE r.physical GROUP BY s.kind,s.entity_id,s.unit
  ), totals AS (
    SELECT kind,entity_id,name,unit,link,sum(shipped) AS shipped,sum(returned) AS returned,
      bool_and(returned<=shipped) AS consistent,bool_and(verified) AS verified
    FROM subjects GROUP BY kind,entity_id,name,unit,link
  ), peers AS (
    SELECT t.*,coalesce(r.physical_returns,0) AS physical_returns,r.return_numbers,
      sum(t.shipped) FILTER (WHERE t.consistent AND t.verified) OVER same_unit
        - CASE WHEN t.consistent AND t.verified THEN t.shipped ELSE 0 END AS peer_shipped,
      sum(t.returned) FILTER (WHERE t.consistent AND t.verified) OVER same_unit
        - CASE WHEN t.consistent AND t.verified THEN t.returned ELSE 0 END AS peer_returned
    FROM totals t LEFT JOIN receipts r USING (kind,entity_id,unit)
    WINDOW same_unit AS (PARTITION BY t.kind,t.unit)
  ), rates AS (
    SELECT p.*,p.consistent AND p.verified AND p.physical_returns>=2 AND p.peer_shipped>0
      AND p.returned*p.peer_shipped>p.peer_returned*p.shipped AS high
    FROM peers p WHERE p.returned>0
  )`;
}

const summary='Compares physically received quantities with fulfilled sales in the history available on your plan. A high rate means at least two separate physical returns and a higher share returned than other SKUs or customers in your inventory measured in the same unit. Other return history stays visible.';
const report=`${comparison('$3')}
  SELECT kind AS "Group",name AS "Name",unit AS "Unit",trim_scale(shipped) AS "Fulfilled units",
    trim_scale(returned) AS "Returned units",round(100*returned/shipped,1) AS "Returned %",
    round(100*peer_returned/nullif(peer_shipped,0),1) AS "Peer return %",
    physical_returns AS "Physical returns",return_numbers AS "Received return references",
    CASE WHEN NOT consistent THEN 'Check returned quantities against fulfillment'
      WHEN NOT verified THEN 'Check physical receipt evidence'
      WHEN high THEN 'High return rate'
      WHEN coalesce(peer_shipped,0)=0 THEN 'No comparable sales history'
      WHEN physical_returns<2 THEN 'Fewer than two separate physical returns'
      ELSE 'At or below peer rate' END AS "Finding",link
  FROM rates WHERE ($2='' OR lower(name)=lower($2))
  ORDER BY high DESC NULLS LAST,returned/shipped DESC,returned DESC,kind,name,link,unit`;

function notices(historyFrom) {
  return `${comparison(historyFrom)}
    SELECT 116 AS job,kind,jsonb_build_array(entity_id,unit)::text AS ref,link,$3::date AS due
    FROM rates WHERE high`;
}

module.exports={summary,report,notices};
