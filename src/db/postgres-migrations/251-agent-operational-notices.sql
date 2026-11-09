CREATE TABLE stockchief_runtime.agent_operational_notices (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id smallint NOT NULL CHECK (job_id IN (124,168)),
  kind text NOT NULL,
  reference text NOT NULL,
  link text NOT NULL,
  due date NOT NULL,
  last_reminded date NOT NULL,
  reminders integer NOT NULL DEFAULT 1,
  resolved boolean NOT NULL DEFAULT false,
  PRIMARY KEY(workspace_id,job_id,kind,reference,link)
);
CREATE INDEX agent_open_operational_notices ON stockchief_runtime.agent_operational_notices(workspace_id,job_id,due) WHERE NOT resolved;
INSERT INTO commercial_storage_tables(relation,bytes_expression)
  VALUES('stockchief_runtime.agent_operational_notices'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.agent_operational_notices'::regclass,true FROM workspaces;
