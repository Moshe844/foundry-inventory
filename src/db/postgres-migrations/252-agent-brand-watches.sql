CREATE TABLE stockchief_runtime.agent_brand_watches (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_key text NOT NULL,
  brand_name text NOT NULL,
  threshold numeric(24,6) NOT NULL CHECK (threshold>=0),
  inclusive boolean NOT NULL,
  updated_by text NOT NULL REFERENCES users(id),
  PRIMARY KEY (workspace_id,brand_key)
);
ALTER TABLE stockchief_runtime.agent_operational_notices DROP CONSTRAINT agent_operational_notices_job_id_check;
ALTER TABLE stockchief_runtime.agent_operational_notices ADD CHECK (job_id IN (124,167,168));
INSERT INTO commercial_storage_tables(relation,bytes_expression)
  VALUES('stockchief_runtime.agent_brand_watches'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.agent_brand_watches'::regclass,true FROM workspaces;
