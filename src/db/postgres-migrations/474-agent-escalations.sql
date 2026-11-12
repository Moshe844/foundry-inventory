-- Job 172: pass an alert or approval nobody answers to the next person.
--
-- The owner's window and the mailbox for these emails live with the other
-- alert channels (job 172's row).
ALTER TABLE stockchief_runtime.agent_alert_channels
  DROP CONSTRAINT agent_alert_channels_job_id_check,
  ADD CONSTRAINT agent_alert_channels_job_id_check CHECK (job_id IN (166,167,168,170,171,172)),
  ADD COLUMN escalation_hours integer CHECK (escalation_hours IS NULL OR (job_id=172 AND escalation_hours BETWEEN 1 AND 720));

-- One row per open alert (jobs 166 to 171) or approval in the owner's Needs
-- you, while the owner's window is set. It records who has it now, who it was
-- passed to and who answered. A row closes when its alert clears or its
-- approval is decided; it starts again if the same item comes back.
CREATE TABLE stockchief_runtime.agent_escalations (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  item_key text NOT NULL CHECK (length(item_key)<=200),
  source text NOT NULL CHECK (source IN ('ALERT','APPROVAL')),
  job_id smallint CHECK (job_id IS NULL OR job_id BETWEEN 166 AND 171),
  title text NOT NULL CHECK (length(title)<=300),
  href text NOT NULL CHECK (length(href)<=500),
  permission text NOT NULL CHECK (length(permission)<=60),
  amount_minor bigint,
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  opened_at timestamptz NOT NULL,
  step integer NOT NULL DEFAULT 0 CHECK (step>=0),
  holder_user_id text REFERENCES users(id) ON DELETE SET NULL,
  passed_to jsonb NOT NULL DEFAULT '[]'::jsonb,
  passed_at timestamptz,
  status text NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','ANSWERED','CLOSED')),
  answered_by text REFERENCES users(id) ON DELETE SET NULL,
  answered_at timestamptz,
  closed_at timestamptz,
  email_batch text,
  email_communication_id text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,item_key),
  CHECK ((email_batch IS NULL)=(email_communication_id IS NULL))
);
CREATE INDEX agent_escalation_waiting ON stockchief_runtime.agent_escalations(workspace_id,holder_user_id) WHERE status='WAITING';
CREATE INDEX agent_escalation_holder ON stockchief_runtime.agent_escalations(holder_user_id) WHERE holder_user_id IS NOT NULL;
CREATE INDEX agent_escalation_answerer ON stockchief_runtime.agent_escalations(answered_by) WHERE answered_by IS NOT NULL;
CREATE INDEX agent_escalation_batch ON stockchief_runtime.agent_escalations(workspace_id,email_batch) WHERE email_batch IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_escalations'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.agent_escalations'::regclass,true FROM workspaces;
