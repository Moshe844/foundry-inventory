-- Pages read one product's rows by key instead of scanning tables that hold
-- every business on the database.
-- Latest movements of one product (product page "recent activity").
CREATE INDEX IF NOT EXISTS idx_movements_workspace_item_time ON movements(workspace_id,item_id,occurred_at DESC,seq DESC);
-- Posted sales of one product (product page sales chart).
CREATE INDEX IF NOT EXISTS idx_accounting_lines_item ON accounting_journal_lines(workspace_id,item_id) WHERE item_id IS NOT NULL;
-- Values of one product option (variant filters and option lists).
CREATE INDEX IF NOT EXISTS idx_sku_option_values_option ON sku_option_values(option_id,value);

-- A large product is deleted in the background too, with its progress kept.
ALTER TABLE record_removals DROP CONSTRAINT record_removals_kind_check;
ALTER TABLE record_removals ADD CONSTRAINT record_removals_kind_check CHECK(kind IN ('import','product'));
