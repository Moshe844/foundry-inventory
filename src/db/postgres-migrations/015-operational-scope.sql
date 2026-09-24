ALTER TABLE operational_alerts
  ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;

DROP INDEX IF EXISTS uq_operational_alert_active;
CREATE UNIQUE INDEX uq_operational_alert_active
  ON operational_alerts((COALESCE(workspace_id,'')),fingerprint)
  WHERE status IN ('OPEN','DELIVERED','ACKNOWLEDGED');
CREATE INDEX IF NOT EXISTS idx_operational_alert_workspace
  ON operational_alerts(workspace_id,status,last_seen_at DESC);

ALTER TABLE production_certification_runs
  ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_certification_run_workspace
  ON production_certification_runs(workspace_id,started_at DESC);
