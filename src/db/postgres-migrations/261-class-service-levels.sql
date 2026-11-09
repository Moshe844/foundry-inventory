CREATE TABLE stockchief_runtime.class_service_levels (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, location_id text NOT NULL REFERENCES locations(id),
  class text NOT NULL CHECK(class IN ('A','B','C')), service_level integer NOT NULL CHECK(service_level BETWEEN 1 AND 100),
  revision text NOT NULL, authorized_by text NOT NULL REFERENCES users(id),
  PRIMARY KEY(workspace_id,location_id,class)
);
INSERT INTO commercial_storage_tables(relation,bytes_expression)
VALUES('stockchief_runtime.class_service_levels'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
SELECT id,'stockchief_runtime.class_service_levels'::regclass,true FROM workspaces;
