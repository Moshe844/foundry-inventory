-- A paused-work sweep must read its first hundred eligible rows rather than
-- scanning completed jobs and sorting their full payloads on every sweep.
CREATE INDEX jobs_paused_updated_order ON stockchief_runtime.jobs(updated_at,id)
 WHERE status='PAUSED' AND workspace_id IS NOT NULL;
