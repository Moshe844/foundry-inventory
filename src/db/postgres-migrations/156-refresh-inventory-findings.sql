CREATE INDEX attention_open_stock_sku ON attention_items(workspace_id,sku_id)
 WHERE status='OPEN' AND category IN('replenishment_needed','low_stock','stockout_risk','location_imbalance');
CREATE FUNCTION stockchief_expire_stock_findings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE attention_items a SET status='RESOLVED',resolved_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),resolution_reason='Stock changed. A fresh stock review has been requested.'
 FROM(SELECT DISTINCT workspace_id,sku_id FROM changed_stock) m
 WHERE a.workspace_id=m.workspace_id AND a.sku_id=m.sku_id AND a.status='OPEN'
  AND a.category IN('replenishment_needed','low_stock','stockout_risk','location_imbalance');
 RETURN NULL;
END;
$$;
CREATE TRIGGER refresh_findings_after_stock AFTER INSERT ON movements REFERENCING NEW TABLE AS changed_stock FOR EACH STATEMENT EXECUTE FUNCTION stockchief_expire_stock_findings();
-- Preserve history, while retiring findings demonstrably older than their stock.
WITH retired AS(UPDATE attention_items a SET status='RESOLVED',resolved_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),resolution_reason='Stock changed after this finding was last checked. A fresh review was requested.'
 WHERE a.status='OPEN' AND a.category IN('replenishment_needed','low_stock','stockout_risk','location_imbalance')
 AND EXISTS(SELECT 1 FROM movements m WHERE m.workspace_id=a.workspace_id AND m.sku_id=a.sku_id AND m.occurred_at::timestamptz>a.last_evaluated_at::timestamptz)
 RETURNING workspace_id)
UPDATE workspace_autopilot SET next_evaluation_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE workspace_id IN(SELECT workspace_id FROM retired);
