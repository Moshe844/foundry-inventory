CREATE TABLE stockchief_runtime.read_model_versions(
 workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 revision BIGINT NOT NULL DEFAULT 0
);
CREATE FUNCTION stockchief_changed_read_model() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO stockchief_runtime.read_model_versions(workspace_id,revision)
 SELECT DISTINCT c.workspace_id,1 FROM changed_rows c JOIN workspaces w ON w.id=c.workspace_id ORDER BY c.workspace_id
 ON CONFLICT(workspace_id) DO UPDATE SET revision=read_model_versions.revision+1;
 RETURN NULL;
END;
$$;
DO $$
DECLARE target RECORD;
BEGIN
 FOR target IN SELECT t.table_schema,t.table_name FROM information_schema.tables t
 WHERE t.table_type='BASE TABLE' AND EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema=t.table_schema AND c.table_name=t.table_name AND c.column_name='workspace_id')
 AND ((t.table_schema='public' AND t.table_name=ANY(ARRAY[
 'users','workspace_custom_roles','items','skus','item_options','item_option_values','sku_option_values','catalogue_item_facts','locations',
 'balances','accounting_inventory_cost_balances','sku_prices','sku_purchase_costs','supplier_items','suppliers','reorder_policies',
 'lots','lot_balances','serial_units','sales_orders','sales_order_lines','sales_order_allocations','inventory_transfers','inventory_transfer_lines',
 'purchase_orders','purchase_order_lines','accounting_settings','accounting_accounts','accounting_journal_entries','accounting_journal_lines',
 'accounting_supplier_bills','accounting_customer_invoices','accounting_payments','accounting_payment_allocations','customers','customer_payment_terms',
 'customer_returns','customer_return_lines','supplier_returns','sales_shipments','work_items','workspace_autopilot','attention_items',
 'connection_issues','workspace_connectors','connection_email_messages','import_executions','repair_cases','catalog_bulk_reviews',
 'custody_agreements','custody_lines','custody_bookings','custody_booking_lines','custody_billing_policies','operational_preferences']::text[]))
 OR (t.table_schema='stockchief_runtime' AND t.table_name=ANY(ARRAY['provider_effects','assistant_action_proposals']::text[])))
 LOOP
  EXECUTE format('CREATE TRIGGER read_model_insert AFTER INSERT ON %I.%I REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model()',target.table_schema,target.table_name);
  EXECUTE format('CREATE TRIGGER read_model_update AFTER UPDATE ON %I.%I REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model()',target.table_schema,target.table_name);
  EXECUTE format('CREATE TRIGGER read_model_delete AFTER DELETE ON %I.%I REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model()',target.table_schema,target.table_name);
 END LOOP;
END;
$$;
CREATE FUNCTION stockchief_changed_workspace_read_model() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO stockchief_runtime.read_model_versions(workspace_id,revision)
 SELECT c.id,1 FROM changed_workspaces c JOIN workspaces w ON w.id=c.id ORDER BY c.id
 ON CONFLICT(workspace_id) DO UPDATE SET revision=read_model_versions.revision+1;
 RETURN NULL;
END;
$$;
CREATE TRIGGER read_model_workspace_update AFTER UPDATE ON workspaces REFERENCING NEW TABLE AS changed_workspaces FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_workspace_read_model();
