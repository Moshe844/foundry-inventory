CREATE TABLE stockchief_runtime.vacation_deputies (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deputy_id text REFERENCES users(id) ON DELETE SET NULL,
  starts_on date NOT NULL, ends_on date NOT NULL CHECK(ends_on>=starts_on),
  revision integer NOT NULL,
  CHECK(owner_id<>deputy_id)
);
INSERT INTO commercial_storage_tables(relation,bytes_expression)
VALUES('stockchief_runtime.vacation_deputies'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
SELECT id,'stockchief_runtime.vacation_deputies'::regclass,true FROM workspaces;
