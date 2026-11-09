CREATE TABLE stockchief_runtime.agent_draft_rules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  scope_key text NOT NULL,
  scope_label text NOT NULL,
  currency text NOT NULL,
  maximum_minor bigint NOT NULL CHECK(maximum_minor>0),
  authorized_by text NOT NULL REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY(workspace_id,action_type,scope_key)
);
INSERT INTO commercial_storage_tables(relation,bytes_expression)
  VALUES('stockchief_runtime.agent_draft_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.agent_draft_rules'::regclass,true FROM workspaces;
