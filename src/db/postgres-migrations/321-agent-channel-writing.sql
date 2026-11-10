ALTER TABLE stockchief_runtime.agent_channel_copy_sets
 ADD COLUMN language text NOT NULL DEFAULT 'English',
 ADD COLUMN tone text NOT NULL DEFAULT 'clear',
 ADD COLUMN channel_style text NOT NULL DEFAULT 'store',
 ADD COLUMN description_limit integer NOT NULL DEFAULT 2000,
 ADD COLUMN all_products boolean NOT NULL DEFAULT false;
ALTER TABLE stockchief_runtime.agent_channel_copy_sets DROP CONSTRAINT agent_channel_copy_sets_title_limit_check;
ALTER TABLE stockchief_runtime.agent_channel_copy_sets ADD CHECK(title_limit BETWEEN 1 AND 1000);
ALTER TABLE stockchief_runtime.agent_channel_copy_sets ADD CHECK(description_limit BETWEEN 1 AND 10000);
-- Earlier routines were zero-credit factual concatenation. Their owner must
-- explicitly authorize the new funded AI-writing behavior before it can run.
UPDATE stockchief_runtime.agent_channel_copy_sets SET enabled=false,revision=revision+1,
 last_issue='Review the AI writing settings and current credit policy, then authorize routine writing again.' WHERE enabled;
CREATE TABLE stockchief_runtime.agent_channel_copy_runs (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 copy_id text NOT NULL REFERENCES stockchief_runtime.agent_channel_copy_sets(id) ON DELETE CASCADE,
 source_hash text NOT NULL,
 source_snapshot jsonb NOT NULL,
 document jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','READY','APPROVED','FAILED')),
 automatic boolean NOT NULL,
 requested_by text NOT NULL REFERENCES users(id),
 credits integer NOT NULL CHECK(credits>0),
 funding_key text NOT NULL,
 run_token text,
 progress integer NOT NULL DEFAULT 0,
 resume_progress boolean NOT NULL DEFAULT false,
 issue text,
 version_id text REFERENCES stockchief_runtime.agent_channel_copy_versions(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,copy_id,source_hash)
);
CREATE INDEX agent_channel_copy_run_owner ON stockchief_runtime.agent_channel_copy_runs(requested_by);
CREATE INDEX agent_channel_copy_run_parent ON stockchief_runtime.agent_channel_copy_runs(copy_id);
CREATE INDEX agent_channel_copy_run_history ON stockchief_runtime.agent_channel_copy_runs(workspace_id,copy_id,created_at DESC,id DESC);
CREATE INDEX agent_channel_copy_run_version ON stockchief_runtime.agent_channel_copy_runs(version_id);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_channel_copy_runs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_channel_copy_runs'::regclass,true FROM workspaces;
