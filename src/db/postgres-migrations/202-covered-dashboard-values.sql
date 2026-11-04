-- Let Money read its account amounts without visiting wide journal rows, and
-- let stock-value previews read quantities/costs without visiting every row.
-- Keep equal journal keys together so ordinary btree deduplication can apply.
CREATE INDEX IF NOT EXISTS idx_accounting_lines_account_covering ON accounting_journal_lines
 (workspace_id,account_id,entry_id,currency,debit_minor,credit_minor);
CREATE INDEX IF NOT EXISTS idx_inventory_cost_balances_covering ON accounting_inventory_cost_balances
 (workspace_id,sku_id) INCLUDE(quantity_units,total_cost_minor);
DROP INDEX IF EXISTS idx_accounting_lines_account;
ANALYZE accounting_journal_lines;
ANALYZE accounting_inventory_cost_balances;
