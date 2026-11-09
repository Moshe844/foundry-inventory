CREATE TABLE stockchief_runtime.supplier_negotiation_rules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, revision text NOT NULL,
  PRIMARY KEY(workspace_id,supplier_id)
);
INSERT INTO commercial_storage_tables(relation,bytes_expression)
VALUES('stockchief_runtime.supplier_negotiation_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
SELECT id,'stockchief_runtime.supplier_negotiation_rules'::regclass,true FROM workspaces;
