-- Connector polling and preview/lease checks only need unfinished work.
-- Completed and paused history must not be scanned on every status check.
CREATE INDEX jobs_active_workspace_kind ON stockchief_runtime.jobs(workspace_id,kind)
 WHERE status IN ('PENDING','RUNNING','RETRY');
