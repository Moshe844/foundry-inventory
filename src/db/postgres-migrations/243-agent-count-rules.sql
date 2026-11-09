CREATE TABLE stockchief_runtime.agent_count_rules (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  authorized_by text NOT NULL REFERENCES users(id),
  currency text NOT NULL,
  limit_minor bigint NOT NULL CHECK (limit_minor > 0),
  automatic boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE physical_count_reviews
  ADD COLUMN recount_required boolean NOT NULL DEFAULT false,
  ADD COLUMN recounted_by text REFERENCES users(id),
  ADD COLUMN recounted_at timestamptz,
  ADD COLUMN agent_decision jsonb,
  ADD COLUMN submission_key text,
  ADD COLUMN submission_hash text,
  ADD UNIQUE (workspace_id,created_by_user_id,submission_key);

INSERT INTO commercial_storage_tables(relation,bytes_expression)
  VALUES('stockchief_runtime.agent_count_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.agent_count_rules'::regclass,true FROM workspaces;
