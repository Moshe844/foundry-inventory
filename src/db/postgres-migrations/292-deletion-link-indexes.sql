-- Every link that points at a business record needs an index on the linking
-- column. Without one, removing a product, movement, location or account makes
-- PostgreSQL read the whole linked table once per removed row (to clear or check
-- the link). On a shared database that turned one business deletion into hours.
-- Nullable links index only rows that carry a link. Staging built these with
-- CREATE INDEX CONCURRENTLY before this migration, so there it changes nothing.
CREATE INDEX IF NOT EXISTS ix_item_location_balances_location_id ON item_location_balances (location_id);
CREATE INDEX IF NOT EXISTS ix_import_catalogue_bindings_import_id ON import_catalogue_bindings (import_id);
CREATE INDEX IF NOT EXISTS ix_import_catalogue_bindings_item_id ON import_catalogue_bindings (item_id);
CREATE INDEX IF NOT EXISTS ix_import_catalogue_bindings_sku_id ON import_catalogue_bindings (sku_id);
CREATE INDEX IF NOT EXISTS ix_work_items_approved_by_user_id ON work_items (approved_by_user_id) WHERE approved_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_work_items_policy_id ON work_items (policy_id) WHERE policy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_sku_prices_created_by_user_id ON sku_prices (created_by_user_id) WHERE created_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_sku_prices_sku_id ON sku_prices (sku_id);
CREATE INDEX IF NOT EXISTS ix_acc_journal_entries_approved_by_user_id ON accounting_journal_entries (approved_by_user_id) WHERE approved_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_acc_journal_entries_created_by_user_id ON accounting_journal_entries (created_by_user_id) WHERE created_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_acc_journal_entries_period_id ON accounting_journal_entries (period_id);
CREATE INDEX IF NOT EXISTS ix_acc_journal_entries_reversal_of_entry_id ON accounting_journal_entries (reversal_of_entry_id) WHERE reversal_of_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_work_item_events_actor_user_id ON work_item_events (actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_reorder_policies_location_id ON reorder_policies (location_id) WHERE location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_reorder_policies_preferred_supplier_id ON reorder_policies (preferred_supplier_id) WHERE preferred_supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_reorder_policies_sku_id ON reorder_policies (sku_id);
CREATE INDEX IF NOT EXISTS ix_import_rows_item_id ON import_rows (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_import_rows_location_id ON import_rows (location_id) WHERE location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_import_rows_lot_id ON import_rows (lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_import_rows_sku_id ON import_rows (sku_id) WHERE sku_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_catalog_source_facts_location_id ON catalog_source_facts (location_id) WHERE location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_catalog_source_facts_sku_id ON catalog_source_facts (sku_id);
CREATE INDEX IF NOT EXISTS ix_catalog_source_facts_source_import_id ON catalog_source_facts (source_import_id) WHERE source_import_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_acc_inv_cost_movements_inventory_movement_id ON accounting_inventory_cost_movements (inventory_movement_id);
CREATE INDEX IF NOT EXISTS ix_acc_inv_cost_movements_journal_entry_id ON accounting_inventory_cost_movements (journal_entry_id) WHERE journal_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_acc_inv_cost_movements_location_id ON accounting_inventory_cost_movements (location_id);
CREATE INDEX IF NOT EXISTS ix_acc_inv_cost_movements_sku_id ON accounting_inventory_cost_movements (sku_id);
CREATE INDEX IF NOT EXISTS ix_acc_inv_cost_balances_location_id ON accounting_inventory_cost_balances (location_id);
CREATE INDEX IF NOT EXISTS ix_acc_inv_cost_balances_sku_id ON accounting_inventory_cost_balances (sku_id);
CREATE INDEX IF NOT EXISTS ix_movements_counterparty_location_id ON movements (counterparty_location_id) WHERE counterparty_location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_movements_lot_id ON movements (lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_movements_serial_unit_id ON movements (serial_unit_id) WHERE serial_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_acc_journal_lines_account_id ON accounting_journal_lines (account_id);
-- Smaller tables that still hold one row per product, movement, item or import,
-- each read once per removed row without an index.
CREATE INDEX IF NOT EXISTS ix_codex_pilot_calls_goal_id ON stockchief_runtime.codex_pilot_calls (goal_id);
CREATE INDEX IF NOT EXISTS ix_commercial_model_cost_holds_goal_id ON commercial_model_cost_holds (goal_id) WHERE goal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_lots_sku_id ON lots (sku_id);
CREATE INDEX IF NOT EXISTS ix_adjustments_location_id ON adjustments (location_id);
CREATE INDEX IF NOT EXISTS ix_adjustments_movement_id ON adjustments (movement_id);
CREATE INDEX IF NOT EXISTS ix_adjustments_sku_id ON adjustments (sku_id);
CREATE INDEX IF NOT EXISTS ix_adjustments_lot_id ON adjustments (lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_import_execution_identities_import_id ON import_execution_identities (import_id);
CREATE INDEX IF NOT EXISTS ix_sku_purchase_costs_supplier_item_id ON sku_purchase_costs (supplier_item_id) WHERE supplier_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_sku_purchase_costs_sku_id ON sku_purchase_costs (sku_id);
CREATE INDEX IF NOT EXISTS ix_catalogue_item_facts_item_id ON catalogue_item_facts (item_id);
CREATE INDEX IF NOT EXISTS ix_commercial_usage_allocations_rollover_id ON commercial_usage_allocations (rollover_id) WHERE rollover_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_commercial_usage_allocations_event_id ON commercial_usage_allocations (event_id);
CREATE INDEX IF NOT EXISTS ix_supplier_items_sku_id ON supplier_items (sku_id);
CREATE INDEX IF NOT EXISTS ix_supplier_items_supplier_id ON supplier_items (supplier_id);
CREATE INDEX IF NOT EXISTS ix_business_reconciliation_checks_run_id ON stockchief_runtime.business_reconciliation_checks (run_id);
