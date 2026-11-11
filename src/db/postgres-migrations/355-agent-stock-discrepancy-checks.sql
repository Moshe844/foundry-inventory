CREATE TABLE stockchief_runtime.agent_stock_discrepancy_checks (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  checked_on date NOT NULL,
  findings integer NOT NULL CHECK (findings >= 0)
);

INSERT INTO commercial_storage_tables(relation,bytes_expression)
  VALUES('stockchief_runtime.agent_stock_discrepancy_checks'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.agent_stock_discrepancy_checks'::regclass,true FROM workspaces;
