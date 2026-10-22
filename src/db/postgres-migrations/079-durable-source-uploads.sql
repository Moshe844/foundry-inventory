-- Persist a reading request before interpreting an untrusted source. Preparing
-- a preview never grants permission to import inventory or financial records.
CREATE TABLE import_source_uploads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES stockchief_runtime.jobs(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_bytes BIGINT NOT NULL CHECK(source_bytes>0),
  source_content BYTEA,
  input_options JSONB NOT NULL DEFAULT '{}'::jsonb,
  plan_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours',
  UNIQUE(workspace_id,actor_id,request_key),
  FOREIGN KEY(plan_id,workspace_id) REFERENCES import_plans(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX import_source_uploads_workspace ON import_source_uploads(workspace_id,created_at DESC,id);
