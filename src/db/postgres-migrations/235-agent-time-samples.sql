CREATE TABLE stockchief_runtime.agent_time_samples (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 recorded_by text NOT NULL REFERENCES users(id),
 activity text NOT NULL CHECK(activity IN ('repeat-order','supplier-response')),
 manual_minutes numeric(8,2) NOT NULL CHECK(manual_minutes BETWEEN 0 AND 1440),
 review_minutes numeric(8,2) NOT NULL CHECK(review_minutes BETWEEN 0 AND 1440),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id)
);
CREATE INDEX agent_time_samples_work ON stockchief_runtime.agent_time_samples(workspace_id,activity);
