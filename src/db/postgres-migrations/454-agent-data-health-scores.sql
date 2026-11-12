-- Job 200: a data health score on day one, with a fix list. Each row is one
-- score: worked out after an import, once a business day by the worker, or
-- when the owner asks. checks holds how many active SKUs passed and failed
-- each check, so the page and Needs you show the latest score and its trend.
CREATE TABLE stockchief_runtime.agent_data_health_scores (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  score int NOT NULL CHECK (score BETWEEN 0 AND 100),
  products int NOT NULL CHECK (products>=0),
  checks jsonb NOT NULL,
  reason text NOT NULL CHECK (reason IN ('FIRST','IMPORT','DAILY','CHECK')),
  computed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_data_health_latest ON stockchief_runtime.agent_data_health_scores(workspace_id,computed_at DESC,id);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_data_health_scores'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation='stockchief_runtime.agent_data_health_scores'::regclass;
