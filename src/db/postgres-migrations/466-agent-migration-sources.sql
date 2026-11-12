-- Job 190: moves your data in from your old system on day one. The original
-- export files of each migration are kept with it, unchanged, as the evidence
-- its records and totals were read from.
CREATE TABLE stockchief_runtime.agent_migration_sources (
  package_id text NOT NULL REFERENCES migration_packages(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position int NOT NULL CHECK (position BETWEEN 0 AND 19),
  file_name text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (package_id,position)
);
CREATE INDEX agent_migration_sources_workspace ON stockchief_runtime.agent_migration_sources(workspace_id,created_at DESC);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_migration_sources'::regclass,'octet_length(t.content)+octet_length(t.file_name)+64');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation='stockchief_runtime.agent_migration_sources'::regclass;
