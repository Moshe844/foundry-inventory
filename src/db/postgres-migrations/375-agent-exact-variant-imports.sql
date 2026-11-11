CREATE TABLE stockchief_runtime.agent_variant_imports (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 actor_id text REFERENCES users(id) ON DELETE SET NULL,
 job_id text REFERENCES stockchief_runtime.jobs(id) ON DELETE SET NULL,
 filename text NOT NULL,
 source_hash text NOT NULL,
 content bytea NOT NULL CHECK(octet_length(content)>0),
 automatic boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','REVIEW','APPROVED','APPLYING','APPLIED','FAILED')),
 revision integer NOT NULL DEFAULT 1,
 mappings jsonb NOT NULL DEFAULT '{}',
 sheets jsonb NOT NULL DEFAULT '[]',
 summary jsonb NOT NULL DEFAULT '{}',
 review_hash text,
 result jsonb,
 issue text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,source_hash),
 UNIQUE(workspace_id,id)
);
CREATE INDEX variant_import_history ON stockchief_runtime.agent_variant_imports(workspace_id,created_at DESC,id);
CREATE INDEX variant_import_job ON stockchief_runtime.agent_variant_imports(job_id);
CREATE INDEX variant_import_actor ON stockchief_runtime.agent_variant_imports(actor_id);
CREATE TABLE stockchief_runtime.agent_variant_import_rows (
 workspace_id text NOT NULL,
 import_id text NOT NULL,
 row_index integer NOT NULL,
 source_sheet integer NOT NULL,
 source_row integer NOT NULL,
 part text NOT NULL DEFAULT '',
 candidate jsonb NOT NULL,
 preview jsonb NOT NULL,
 PRIMARY KEY(import_id,row_index),
 FOREIGN KEY(workspace_id,import_id) REFERENCES stockchief_runtime.agent_variant_imports(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX variant_import_rows_workspace ON stockchief_runtime.agent_variant_import_rows(workspace_id,import_id,row_index);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_variant_imports'::regclass,'octet_length(t.content)+octet_length(convert_to((to_jsonb(t)-''content'')::text,''UTF8''))'),
 ('stockchief_runtime.agent_variant_import_rows'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_variant_imports'::regclass,
 'stockchief_runtime.agent_variant_import_rows'::regclass])r;
