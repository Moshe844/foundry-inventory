-- Job 187: replies StockChief wrote for Gmail or Outlook mail, and what
-- happened to each one: sent on its own, kept for a person, watched only or
-- stopped for a person, with the reason. One row per email; a newer draft of
-- the same email replaces the row's outcome.
CREATE TABLE stockchief_runtime.agent_mail_replies (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES connection_email_messages(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  sender text NOT NULL,
  contact_kind text CHECK (contact_kind IN ('customer','supplier')),
  contact_id text,
  contact_name text,
  subject text,
  status text NOT NULL CHECK (status IN ('WATCHED','HELD','DRAFTED','QUEUED','SENT','FAILED')),
  reason text,
  draft_digest text NOT NULL,
  outbox_id text,
  automatic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,message_id),
  CHECK (status NOT IN ('QUEUED','SENT') OR outbox_id IS NOT NULL)
);
CREATE INDEX agent_mail_replies_message ON stockchief_runtime.agent_mail_replies(message_id);
CREATE INDEX agent_mail_replies_connector ON stockchief_runtime.agent_mail_replies(connector_id);
CREATE INDEX agent_mail_replies_waiting ON stockchief_runtime.agent_mail_replies(workspace_id,updated_at) WHERE status IN ('WATCHED','HELD','DRAFTED','FAILED');
CREATE INDEX agent_mail_replies_recent ON stockchief_runtime.agent_mail_replies(workspace_id,updated_at DESC,message_id);

-- The owner's rules for replies sent on their own: which connected mailbox
-- StockChief answers from (with two or more, nothing is sent until the owner
-- chooses one), and whether customers and suppliers are answered alone.
CREATE TABLE stockchief_runtime.agent_mail_reply_settings (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id text REFERENCES workspace_connectors(id) ON DELETE SET NULL,
  customers boolean NOT NULL DEFAULT true,
  suppliers boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_mail_reply_settings_connector ON stockchief_runtime.agent_mail_reply_settings(connector_id) WHERE connector_id IS NOT NULL;
CREATE INDEX agent_mail_reply_settings_author ON stockchief_runtime.agent_mail_reply_settings(updated_by);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_mail_replies'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_mail_reply_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN (VALUES
    ('stockchief_runtime.agent_mail_replies'::regclass),
    ('stockchief_runtime.agent_mail_reply_settings'::regclass)) r(relation);
