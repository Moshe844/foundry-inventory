-- Maintenance reads a bounded page in inventory/id order. The global primary
-- keys can otherwise scan other customers' history before finding that page.
CREATE INDEX reconciliation_skus_workspace_id ON skus(workspace_id,id);
CREATE INDEX reconciliation_journals_workspace_id ON accounting_journal_entries(workspace_id,id);
CREATE INDEX reconciliation_purchase_lines_workspace_id ON purchase_order_lines(workspace_id,id);
CREATE INDEX reconciliation_provider_effects_workspace_id ON stockchief_runtime.provider_effects(workspace_id,id);
