ALTER TABLE stockchief_runtime.agent_operational_notices
  DROP CONSTRAINT agent_operational_notices_job_id_check,
  ADD CONSTRAINT agent_operational_notices_job_id_check
    CHECK (job_id IN (10,50,67,87,110,116,124,167,168,169,170,171,204,206,209)),
  ADD COLUMN history_from date;

CREATE INDEX customer_return_lines_received_by_order_line
  ON customer_return_lines(workspace_id,sales_order_line_id)
  WHERE quantity_received>0;
