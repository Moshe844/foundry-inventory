ALTER TABLE workspaces ADD COLUMN active_cutover_id TEXT REFERENCES migration_packages(id);
CREATE OR REPLACE FUNCTION stockchief_cutover_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workspace TEXT; active_package TEXT;
BEGIN
 IF TG_OP='DELETE' THEN workspace:=OLD.workspace_id; ELSE workspace:=NEW.workspace_id; END IF;
 SELECT active_cutover_id INTO active_package FROM workspaces WHERE id=workspace FOR SHARE;
 IF active_package IS NOT NULL AND current_setting('stockchief.cutover_package_id',true) IS DISTINCT FROM active_package THEN
  RAISE EXCEPTION 'This inventory is completing its ERP cutover. New operating changes are paused until reconciliation finishes.' USING ERRCODE='55000';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
DO $$ DECLARE name TEXT; BEGIN
 FOREACH name IN ARRAY ARRAY['items','skus','locations','balances','movements','lot_balances','serial_units','suppliers','supplier_items','customers','purchase_orders','purchase_order_lines','sales_orders','sales_order_lines','sales_order_allocations','sku_prices','sku_purchase_costs','reorder_policies','inventory_availability_holds','accounting_journal_entries','accounting_journal_lines','accounting_inventory_cost_balances','accounting_inventory_cost_movements','accounting_supplier_bills','accounting_customer_invoices','accounting_payments'] LOOP
  EXECUTE format('CREATE TRIGGER cutover_write_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION stockchief_cutover_write_guard()',name);
 END LOOP;
END; $$;
