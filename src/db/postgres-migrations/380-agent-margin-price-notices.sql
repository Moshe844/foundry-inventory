ALTER TABLE stockchief_runtime.agent_operational_notices
  DROP CONSTRAINT agent_operational_notices_job_id_check,
  ADD CONSTRAINT agent_operational_notices_job_id_check
    CHECK (job_id IN (10,50,67,77,80,87,110,116,124,167,168,169,170,171,204,206,209));

CREATE INDEX margin_price_posted_receipt_costs
  ON accounting_inventory_cost_movements(workspace_id,sku_id,cost_source_record_id)
  WHERE cost_source_type='purchase_order_receipt' AND quantity_delta>0;

CREATE INDEX margin_price_supplier_bill_sku
  ON accounting_supplier_bill_lines(workspace_id,sku_id,bill_id)
  WHERE purchase_order_line_id IS NOT NULL;
