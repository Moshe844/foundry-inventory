-- Job 188: questions from Microsoft Teams and WhatsApp, beside the existing
-- Slack tables (340). Each person links their own Teams user (with a one-use
-- code) or their confirmed mobile number (job 173) before StockChief answers.
--
-- One connection per inventory and channel. Teams keeps the owner's bot
-- registration; WhatsApp uses the server's own Twilio sender, so it keeps none.
CREATE TABLE stockchief_runtime.agent_chat_connections (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('teams','whatsapp')),
  endpoint_id text NOT NULL UNIQUE CHECK (length(endpoint_id)=32),
  tenant text CHECK (tenant IS NULL OR length(tenant)=36),
  app text CHECK (app IS NULL OR length(app)=36),
  sealed_secret jsonb,
  enabled boolean NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  PRIMARY KEY (workspace_id,channel),
  CHECK (channel<>'teams' OR (tenant IS NOT NULL AND app IS NOT NULL AND sealed_secret IS NOT NULL))
);

CREATE TABLE stockchief_runtime.agent_chat_members (
  workspace_id text NOT NULL,
  channel text NOT NULL,
  actor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_user text CHECK (external_user IS NULL OR length(external_user) BETWEEN 3 AND 100),
  code_hash text CHECK (code_hash IS NULL OR length(code_hash)=64),
  code_expires_at timestamptz,
  PRIMARY KEY (workspace_id,channel,actor_id),
  FOREIGN KEY (workspace_id,channel) REFERENCES stockchief_runtime.agent_chat_connections(workspace_id,channel) ON DELETE CASCADE,
  UNIQUE (workspace_id,channel,external_user),
  UNIQUE (workspace_id,channel,code_hash)
);
CREATE INDEX agent_chat_member_actor ON stockchief_runtime.agent_chat_members(actor_id);
-- A WhatsApp number reaches one inventory: the shared sender has to know whose
-- records to read.
CREATE UNIQUE INDEX agent_chat_member_whatsapp ON stockchief_runtime.agent_chat_members(external_user) WHERE channel='whatsapp' AND external_user IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_chat_questions (
  workspace_id text NOT NULL,
  id text NOT NULL,
  channel text NOT NULL,
  actor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_user text NOT NULL,
  connection_revision integer NOT NULL,
  fingerprint text NOT NULL CHECK (length(fingerprint)=64),
  sealed_question jsonb,
  status text NOT NULL CHECK (status IN ('PENDING','CLAIMED','REPLIED','HELD')),
  problem_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,channel) REFERENCES stockchief_runtime.agent_chat_connections(workspace_id,channel) ON DELETE CASCADE,
  UNIQUE (workspace_id,channel,fingerprint)
);
CREATE INDEX agent_chat_question_recent ON stockchief_runtime.agent_chat_questions(workspace_id,actor_id,created_at DESC);
CREATE INDEX agent_chat_question_actor ON stockchief_runtime.agent_chat_questions(actor_id);
CREATE INDEX agent_chat_question_expire ON stockchief_runtime.agent_chat_questions(expires_at) WHERE sealed_question IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_chat_connections'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_chat_members'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_chat_questions'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN (VALUES
    ('stockchief_runtime.agent_chat_connections'::regclass),
    ('stockchief_runtime.agent_chat_members'::regclass),
    ('stockchief_runtime.agent_chat_questions'::regclass)) r(relation);
