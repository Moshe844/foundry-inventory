-- A queued evaluation needs only completed cycles newer than its request.
-- Keep the result JSON out of the index; it can contain a large plan.
CREATE INDEX jobs_completed_autopilot_window
 ON stockchief_runtime.jobs(workspace_id,completed_at DESC) INCLUDE(id)
 WHERE kind='autopilot.evaluate' AND status='COMPLETED' AND result->>'partial'='false';
