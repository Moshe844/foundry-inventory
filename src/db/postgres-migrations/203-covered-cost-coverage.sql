-- Aggregate the per-position source without fetching its heap rows. All keys
-- are values used by the totals view, so repeated import quantities can use
-- btree deduplication. No shared totals row or write-side lock is introduced.
CREATE INDEX IF NOT EXISTS idx_inventory_cost_coverage_values
 ON inventory_cost_coverage_positions
 (workspace_id,missing_units,physical_units,costed_units,book_cost_minor);
-- Cold Home reads need the same narrow physical quantities and SKU identity
-- as stock availability; avoid fetching complete catalogue/position records.
CREATE INDEX IF NOT EXISTS idx_balances_workspace_covering
 ON balances(workspace_id,sku_id,location_id) INCLUDE(on_hand);
CREATE INDEX IF NOT EXISTS idx_skus_workspace_summary_covering
 ON skus(workspace_id,id) INCLUDE(item_id,is_active);
ANALYZE inventory_cost_coverage_positions;
ANALYZE balances;
ANALYZE skus;
