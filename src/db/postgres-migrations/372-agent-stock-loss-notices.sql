ALTER TABLE stockchief_runtime.agent_operational_notices
  DROP CONSTRAINT agent_operational_notices_job_id_check,
  ADD CONSTRAINT agent_operational_notices_job_id_check
    CHECK (job_id IN (10,50,67,87,110,124,167,168,169,170,171,204,206,209));

CREATE INDEX idx_movements_stock_loss_time
  ON movements(workspace_id,stockchief_movement_instant(occurred_at))
  INCLUDE (sku_id,location_id,quantity_delta,reason_code)
  WHERE operation='adjust' AND quantity_delta<0;
