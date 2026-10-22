-- Every provenance check is tenant-scoped. Without these indexes a small
-- business's history repeatedly scanned every other business's import rows.
-- JSON membership indexes also bound the work for large single businesses.
CREATE INDEX IF NOT EXISTS ix_import_rows_workspace ON import_rows(workspace_id);
CREATE INDEX IF NOT EXISTS ix_import_rows_movement_ids ON import_rows USING gin ((movement_ids::jsonb));
CREATE INDEX IF NOT EXISTS ix_purchase_receipt_lines_workspace ON purchase_order_receipt_lines(workspace_id);
CREATE INDEX IF NOT EXISTS ix_purchase_receipt_lines_movement_ids ON purchase_order_receipt_lines USING gin ((movement_ids::jsonb));
CREATE INDEX IF NOT EXISTS ix_customer_return_lines_workspace ON customer_return_lines(workspace_id);
CREATE INDEX IF NOT EXISTS ix_customer_return_lines_received_movements ON customer_return_lines USING gin ((receive_movement_ids::jsonb));
CREATE INDEX IF NOT EXISTS ix_customer_return_lines_disposition_movements ON customer_return_lines USING gin ((disposition_movement_ids::jsonb));
