CREATE TABLE stockchief_runtime.agent_slack_apps (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  endpoint_id text NOT NULL UNIQUE,
  slack_team text NOT NULL,
  slack_app text NOT NULL,
  sealed_secret jsonb NOT NULL,
  enabled boolean NOT NULL,
  revision integer NOT NULL DEFAULT 1
);

CREATE TABLE stockchief_runtime.agent_slack_members (
  workspace_id text NOT NULL REFERENCES stockchief_runtime.agent_slack_apps(workspace_id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slack_user text,
  code_hash text,
  code_expires_at timestamptz,
  PRIMARY KEY(workspace_id,actor_id),
  UNIQUE(workspace_id,slack_user),
  UNIQUE(workspace_id,code_hash)
);

CREATE TABLE stockchief_runtime.agent_slack_questions (
  workspace_id text NOT NULL REFERENCES stockchief_runtime.agent_slack_apps(workspace_id) ON DELETE CASCADE,
  id text NOT NULL,
  actor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slack_user text NOT NULL,
  app_revision integer NOT NULL,
  fingerprint text NOT NULL,
  sealed_question jsonb,
  status text NOT NULL CHECK (status IN ('PENDING','CLAIMED','REPLIED','HELD')),
  problem_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,fingerprint)
);
CREATE INDEX agent_slack_questions_recent ON stockchief_runtime.agent_slack_questions(workspace_id,actor_id,created_at DESC);
CREATE INDEX agent_slack_questions_expire ON stockchief_runtime.agent_slack_questions(expires_at);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_slack_apps'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_slack_members'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_slack_questions'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables r
 WHERE r.relation IN ('stockchief_runtime.agent_slack_apps'::regclass,'stockchief_runtime.agent_slack_members'::regclass,
 'stockchief_runtime.agent_slack_questions'::regclass);
