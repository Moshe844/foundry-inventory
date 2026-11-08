CREATE TABLE stockchief_runtime.location_reorder_rules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id text NOT NULL REFERENCES skus(id), location_id text NOT NULL REFERENCES locations(id),
  authorized_by text NOT NULL REFERENCES users(id), ceiling integer NOT NULL CHECK(ceiling>0),
  PRIMARY KEY(workspace_id,sku_id,location_id)
);
INSERT INTO commercial_storage_tables(relation,bytes_expression)
VALUES('stockchief_runtime.location_reorder_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
SELECT id,'stockchief_runtime.location_reorder_rules'::regclass,true FROM workspaces;
