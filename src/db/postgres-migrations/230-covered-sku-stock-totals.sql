-- Cold Home counts need the quantity for every SKU. Cover that read without
-- fetching a separate heap tuple for each variant. Preserve the same durable
-- table and primary-key uniqueness; replace rather than duplicate its index.
SET LOCAL lock_timeout='1000ms';
CREATE UNIQUE INDEX sku_stock_totals_covered ON stockchief_runtime.sku_stock_totals(workspace_id,sku_id) INCLUDE(on_hand);
ALTER TABLE stockchief_runtime.sku_stock_totals DROP CONSTRAINT sku_stock_totals_pkey,
 ADD CONSTRAINT sku_stock_totals_pkey PRIMARY KEY USING INDEX sku_stock_totals_covered;
CREATE INDEX idx_items_workspace_stock_precision ON items(workspace_id,quantity_precision,id);
SET LOCAL lock_timeout='120000ms';
