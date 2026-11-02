-- Customer Home must not scan healthy job history to show a few failures.
-- Keep error bodies in the table so this partial index stays small.
CREATE INDEX jobs_dead_workspace_kind ON stockchief_runtime.jobs(workspace_id,kind)
 WHERE status='DEAD';
