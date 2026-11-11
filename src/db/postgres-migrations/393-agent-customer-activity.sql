ALTER TABLE stockchief_runtime.agent_operational_notices
  DROP CONSTRAINT agent_operational_notices_job_id_check,
  ADD CONSTRAINT agent_operational_notices_job_id_check
    CHECK (job_id IN (10,50,67,77,80,82,87,88,91,110,116,124,167,168,169,170,171,204,206,209));

CREATE INDEX sales_customer_activity_shipments ON sales_shipments(workspace_id,shipped_at)
  WHERE status IN ('SHIPPED','DELIVERED') AND customer_return_id IS NULL AND shipped_at IS NOT NULL;
CREATE INDEX sales_customer_activity_lines ON sales_shipment_lines(workspace_id,shipment_id)
  WHERE quantity>0;
