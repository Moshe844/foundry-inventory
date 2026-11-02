-- Home and Needs you display four active checks and the latest result of each
-- maintenance kind. Keep both reads independent of completed job history.
CREATE INDEX jobs_active_maintenance_workspace_order
 ON stockchief_runtime.jobs(workspace_id,priority,created_at,id)
 WHERE kind IN('autopilot.evaluate','system.reconcile-business')
  AND status IN('PENDING','RETRY','RUNNING');
CREATE INDEX jobs_latest_maintenance_workspace_kind
 ON stockchief_runtime.jobs(workspace_id,kind,updated_at DESC,id DESC)
 WHERE kind IN('autopilot.evaluate','system.reconcile-business');
