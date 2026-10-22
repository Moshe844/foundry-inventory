-- Keep the original source independent of optional model interpretation.
-- The preview remains unapproved; retaining bytes grants no business authority.
CREATE UNIQUE INDEX import_plans_id_workspace_source ON import_plans(id,workspace_id);
CREATE TABLE import_source_snapshots (
  import_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  source_content BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(import_id,workspace_id) REFERENCES import_plans(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX import_source_snapshots_workspace ON import_source_snapshots(workspace_id,import_id);
