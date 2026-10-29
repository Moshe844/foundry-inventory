-- Stable indexed continuation for ordinary catalogue browsing. Stock filters
-- and stock ordering still use canonical totals before limiting the results.
CREATE INDEX IF NOT EXISTS idx_items_workspace_name_id ON items(workspace_id,name,id);
CREATE INDEX IF NOT EXISTS idx_items_workspace_created_id ON items(workspace_id,created_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_movements_workspace_item ON movements(workspace_id,item_id);
CREATE INDEX IF NOT EXISTS idx_sales_order_lines_workspace_sku ON sales_order_lines(workspace_id,sku_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_workspace_sku ON purchase_order_lines(workspace_id,sku_id);
