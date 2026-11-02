-- Active leases must not scan years of completed Ask/import history.
CREATE INDEX jobs_running_workspace_kind ON stockchief_runtime.jobs(workspace_id,kind) WHERE status='RUNNING';
