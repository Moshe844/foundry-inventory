CREATE TABLE stockchief_runtime.agent_job_modes (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id smallint NOT NULL CHECK (job_id BETWEEN 1 AND 214),
  mode text NOT NULL CHECK (mode IN ('inherit','watch','ask','routine')),
  revision integer NOT NULL CHECK (revision>0),
  updated_by text NOT NULL REFERENCES users(id),
  PRIMARY KEY (workspace_id,job_id)
);
INSERT INTO commercial_storage_tables(relation,bytes_expression)
  VALUES('stockchief_runtime.agent_job_modes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.agent_job_modes'::regclass,true FROM workspaces;
