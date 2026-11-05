-- Page independent stock positions together without sorting the source file
-- or changing its immutable row numbers. The cache is discarded only after
-- canonical verification; old in-progress plans keep their recorded order.
-- NULL belongs to an older cache; '' means a reviewed row had no category.
ALTER TABLE import_execution_identities ADD COLUMN source_category text;
CREATE INDEX import_execution_identity_stock_order ON import_execution_identities
 (workspace_id,import_id,(coalesce(existing_sku_id,product_key||':'||variant_key)),row_number,row_id);

-- Covered reads need visibility-map maintenance after a normal stock batch,
-- rather than waiting for 20% of the entire multi-tenant relation to change.
ALTER TABLE balances SET (autovacuum_vacuum_scale_factor=0.02,
 autovacuum_vacuum_insert_scale_factor=0.02,autovacuum_analyze_scale_factor=0.02);
ALTER TABLE accounting_inventory_cost_balances SET (autovacuum_vacuum_scale_factor=0.02,
 autovacuum_vacuum_insert_scale_factor=0.02,autovacuum_analyze_scale_factor=0.02);
