ALTER TABLE stockchief_runtime.agent_operational_notices DROP CONSTRAINT agent_operational_notices_job_id_check;
ALTER TABLE stockchief_runtime.agent_operational_notices ADD CHECK(job_id IN (67,124,167,168,169,170,171,206,209));
CREATE INDEX idx_agent_repeated_corrections ON movements(workspace_id,occurred_at,sku_id,location_id)
 WHERE operation='adjust' AND quantity_delta<>0;
