ALTER TABLE connection_email_messages ADD COLUMN agent_category_reason text;
ALTER TABLE connection_email_set_aside ADD COLUMN agent_category_reason text;
CREATE INDEX email_internet_original ON connection_email_messages(workspace_id,connector_id,internet_message_id)
 WHERE internet_message_id IS NOT NULL;

CREATE TABLE stockchief_runtime.mailbox_poll_progress (
  connector_id text PRIMARY KEY REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mailbox_identity text NOT NULL,
  window_id text NOT NULL,
  since_at timestamptz NOT NULL,
  until_at timestamptz NOT NULL,
  cursor jsonb,
  page_number integer NOT NULL DEFAULT 0 CHECK(page_number>=0),
  last_cursor_reset_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX mailbox_poll_progress_workspace ON stockchief_runtime.mailbox_poll_progress(workspace_id,connector_id);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.mailbox_poll_progress'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.mailbox_poll_progress'::regclass,true FROM workspaces;
