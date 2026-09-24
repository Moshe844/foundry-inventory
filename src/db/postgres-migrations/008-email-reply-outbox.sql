CREATE TABLE IF NOT EXISTS stockchief_runtime.email_reply_outbox (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES public.connection_email_messages(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES public.workspace_connectors(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  recipient text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('SENDING','SENT','FAILED','AMBIGUOUS')),
  provider_message_id text,
  provider_thread_id text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(workspace_id,idempotency_key)
);

CREATE INDEX IF NOT EXISTS email_reply_outbox_message
  ON stockchief_runtime.email_reply_outbox(workspace_id,message_id,started_at DESC);

CREATE INDEX IF NOT EXISTS email_reply_outbox_recovery
  ON stockchief_runtime.email_reply_outbox(status,started_at)
  WHERE status='SENDING';
