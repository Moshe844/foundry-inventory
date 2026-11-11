-- Customer-direct dispatch receipts support billing. They never deliver stock
-- to a warehouse and must not change the lead time used to replenish one.
CREATE OR REPLACE FUNCTION stockchief_runtime.supplier_lead_history(workspace_key text, sku_key text, supplier_key text)
RETURNS TABLE(samples integer, measured_days numeric, promised_days numeric, planning_days integer)
LANGUAGE sql STABLE AS $$
  WITH first_arrivals AS (
    SELECT p.id, p.ordered_at::timestamptz AS placed, p.expected_date,
      min(r.received_at::timestamptz) AS arrived
    FROM purchase_order_lines l
    JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
    JOIN purchase_order_receipt_lines rl ON rl.workspace_id=l.workspace_id AND rl.purchase_order_line_id=l.id
    JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id AND r.purchase_order_id=p.id
    WHERE l.workspace_id=workspace_key AND l.sku_id=sku_key AND p.supplier_id=supplier_key
      AND p.delivery_kind='WAREHOUSE'
      AND p.status IN ('PARTIALLY_RECEIVED','RECEIVED') AND p.ordered_at IS NOT NULL
      AND p.ordered_at::timestamptz BETWEEN now()-interval '365 days' AND now()
      AND rl.quantity_units>0 AND r.received_at::timestamptz BETWEEN p.ordered_at::timestamptz AND now()
    GROUP BY p.id,p.ordered_at,p.expected_date
    ORDER BY placed DESC,p.id DESC LIMIT 12
  ), durations AS (
    SELECT extract(epoch FROM (arrived-placed))/86400 AS actual,
      expected_date::date-(placed AT TIME ZONE coalesce(w.time_zone,a.time_zone,'UTC'))::date AS promised
    FROM first_arrivals JOIN workspaces w ON w.id=workspace_key JOIN accounts a ON a.id=w.owner_account_id
  )
  SELECT count(*)::integer,round(avg(actual),1),round(avg(promised) FILTER (WHERE promised>=0),1),
    CASE WHEN count(*)>=3 THEN ceil(round(avg(actual),1))::integer END FROM durations
$$;
