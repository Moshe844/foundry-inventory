-- Keep the operating boundary in PostgreSQL for every writer. One statement
-- locks each affected inventory once instead of repeating that lock for every
-- stock, cost and journal row. A refusal still rolls back the whole statement.
SET LOCAL lock_timeout='1000ms';
CREATE FUNCTION stockchief_batch_cutover_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target record; scoped text[];
BEGIN
 IF TG_OP='INSERT' THEN SELECT array_agg(DISTINCT workspace_id) INTO scoped FROM cutover_new_rows;
 ELSIF TG_OP='DELETE' THEN SELECT array_agg(DISTINCT workspace_id) INTO scoped FROM cutover_old_rows;
 ELSE SELECT array_agg(DISTINCT workspace_id) INTO scoped FROM(
  SELECT workspace_id FROM cutover_new_rows UNION SELECT workspace_id FROM cutover_old_rows) changed;
 END IF;
 FOR target IN SELECT id,active_cutover_id FROM workspaces WHERE id=ANY(scoped) ORDER BY id FOR SHARE LOOP
  IF target.active_cutover_id IS NOT NULL AND current_setting('stockchief.cutover_package_id',true) IS DISTINCT FROM target.active_cutover_id THEN
   RAISE EXCEPTION 'This inventory is completing its ERP cutover. New operating changes are paused until reconciliation finishes.' USING ERRCODE='55000';
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
DO $$
DECLARE name text; event text; reference text;
BEGIN
 FOREACH name IN ARRAY ARRAY['items','skus','locations','balances','movements','lot_balances','serial_units','suppliers','supplier_items','customers','purchase_orders','purchase_order_lines','sales_orders','sales_order_lines','sales_order_allocations','sku_prices','sku_purchase_costs','reorder_policies','inventory_availability_holds','accounting_journal_entries','accounting_journal_lines','accounting_inventory_cost_balances','accounting_inventory_cost_movements','accounting_supplier_bills','accounting_customer_invoices','accounting_payments'] LOOP
  EXECUTE format('DROP TRIGGER cutover_write_guard ON %I',name);
  FOREACH event IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
   reference:=CASE event WHEN 'INSERT' THEN 'NEW TABLE AS cutover_new_rows'
    WHEN 'DELETE' THEN 'OLD TABLE AS cutover_old_rows'
    ELSE 'NEW TABLE AS cutover_new_rows OLD TABLE AS cutover_old_rows' END;
   EXECUTE format('CREATE TRIGGER cutover_write_guard_%s AFTER %s ON %I REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION stockchief_batch_cutover_write_guard()',lower(event),event,name,reference);
  END LOOP;
 END LOOP;
END $$;
SET LOCAL lock_timeout='120000ms';
