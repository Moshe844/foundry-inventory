-- Allocation must not count the complete history or reuse a deleted document's
-- number. Counters and document inserts commit in the same transaction.
CREATE TABLE stockchief_runtime.business_number_counters (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 kind text NOT NULL, prefix text NOT NULL, last_number bigint NOT NULL CHECK(last_number>=0),
 PRIMARY KEY(workspace_id,kind,prefix)
);
INSERT INTO stockchief_runtime.business_number_counters(workspace_id,kind,prefix,last_number)
 SELECT workspace_id,kind,split_part(number,'-',1),max(split_part(number,'-',2)::bigint)
 FROM (
  SELECT workspace_id,'purchase_orders' kind,po_number number FROM purchase_orders
  UNION ALL SELECT workspace_id,'sales_orders',order_number FROM sales_orders
  UNION ALL SELECT workspace_id,'accounting_supplier_bills',bill_number FROM accounting_supplier_bills
  UNION ALL SELECT workspace_id,'accounting_customer_invoices',invoice_number FROM accounting_customer_invoices
  UNION ALL SELECT workspace_id,'accounting_payments',payment_number FROM accounting_payments
  UNION ALL SELECT workspace_id,'sales_shipments',shipment_number FROM sales_shipments
 ) documents WHERE number ~ '^[A-Z]+-[0-9]{1,15}$' GROUP BY workspace_id,kind,split_part(number,'-',1);
CREATE FUNCTION stockchief_observe_business_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE number text;
BEGIN
 number=to_jsonb(NEW)->>TG_ARGV[0];
 IF number ~ '^[A-Z]+-[0-9]{1,15}$' THEN
  INSERT INTO stockchief_runtime.business_number_counters(workspace_id,kind,prefix,last_number)
   VALUES(NEW.workspace_id,TG_TABLE_NAME,split_part(number,'-',1),split_part(number,'-',2)::bigint)
   ON CONFLICT(workspace_id,kind,prefix) DO UPDATE SET last_number=EXCLUDED.last_number
    WHERE business_number_counters.last_number<EXCLUDED.last_number;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER business_number_insert AFTER INSERT OR UPDATE OF po_number ON purchase_orders FOR EACH ROW EXECUTE FUNCTION stockchief_observe_business_number('po_number');
CREATE TRIGGER business_number_insert AFTER INSERT OR UPDATE OF order_number ON sales_orders FOR EACH ROW EXECUTE FUNCTION stockchief_observe_business_number('order_number');
CREATE TRIGGER business_number_insert AFTER INSERT OR UPDATE OF bill_number ON accounting_supplier_bills FOR EACH ROW EXECUTE FUNCTION stockchief_observe_business_number('bill_number');
CREATE TRIGGER business_number_insert AFTER INSERT OR UPDATE OF invoice_number ON accounting_customer_invoices FOR EACH ROW EXECUTE FUNCTION stockchief_observe_business_number('invoice_number');
CREATE TRIGGER business_number_insert AFTER INSERT OR UPDATE OF payment_number ON accounting_payments FOR EACH ROW EXECUTE FUNCTION stockchief_observe_business_number('payment_number');
CREATE TRIGGER business_number_insert AFTER INSERT OR UPDATE OF shipment_number ON sales_shipments FOR EACH ROW EXECUTE FUNCTION stockchief_observe_business_number('shipment_number');
