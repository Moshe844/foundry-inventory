-- Jobs 155 and 156: scheduled reports and the daily briefing are emailed
-- from a connected mailbox the owner chose, to people in the business the
-- owner chose. Nothing here sends; the mailbox outbox does, and every send
-- is checked again just before the mailbox sends it.

-- Job 155: who gets each saved report, and the file it carries.
ALTER TABLE stockchief_runtime.report_templates
  ADD COLUMN recipient_user_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(recipient_user_ids)<=20),
  ADD COLUMN attachment_format text NOT NULL DEFAULT 'xlsx' CHECK (attachment_format IN ('xlsx','pdf'));

-- A scheduled slot can wait for the owner: the first 14 days, pause, Watch
-- only, Ask me first, or a missing mailbox or person. Each slot stays one row.
-- HELD joins whatever statuses the table allows by now, so statuses added by
-- other migrations stay allowed.
DO $$
DECLARE allowed text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO allowed FROM pg_constraint
  WHERE conname='report_deliveries_status_check' AND conrelid='stockchief_runtime.report_deliveries'::regclass;
 IF allowed IS NULL OR position('ARRAY[' IN allowed)=0 THEN
  RAISE EXCEPTION 'The report delivery status list has an unexpected form.';
 END IF;
 IF position('''HELD''' IN allowed)=0 THEN
  EXECUTE 'ALTER TABLE stockchief_runtime.report_deliveries DROP CONSTRAINT report_deliveries_status_check, ADD CONSTRAINT report_deliveries_status_check '
   || replace(allowed,'ARRAY[','ARRAY[''HELD''::text, ');
 END IF;
END $$;
ALTER TABLE stockchief_runtime.report_deliveries
  ADD COLUMN hold_reason text CHECK (hold_reason IS NULL OR length(hold_reason)<=500),
  ADD COLUMN communication_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN recipients text[] NOT NULL DEFAULT '{}',
  ADD COLUMN mailbox text,
  ADD COLUMN sent_by_owner boolean NOT NULL DEFAULT false;
CREATE INDEX report_delivery_held ON stockchief_runtime.report_deliveries(workspace_id,created_at DESC) WHERE status='HELD';
CREATE INDEX report_delivery_mailbox_pending ON stockchief_runtime.report_deliveries(workspace_id,id)
  WHERE status='PENDING' AND cardinality(communication_ids)>0;

-- One row per job: the mailbox the owner chose (none means none chosen yet)
-- and, for the briefing, who gets it and when.
CREATE TABLE stockchief_runtime.agent_report_email_settings (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id smallint NOT NULL CHECK (job_id IN (155,156)),
  email_connector_id text,
  recipient_user_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(recipient_user_ids)<=20),
  send_hour smallint NOT NULL DEFAULT 7 CHECK (send_hour BETWEEN 0 AND 23),
  send_minute smallint NOT NULL DEFAULT 0 CHECK (send_minute BETWEEN 0 AND 59),
  send_days text NOT NULL DEFAULT 'daily' CHECK (send_days IN ('daily','weekdays')),
  next_send_at timestamptz,
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision>=0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,job_id),
  CHECK (job_id=156 OR next_send_at IS NULL)
);
CREATE INDEX agent_report_email_due ON stockchief_runtime.agent_report_email_settings(next_send_at) WHERE next_send_at IS NOT NULL;
CREATE INDEX agent_report_email_owner ON stockchief_runtime.agent_report_email_settings(authorized_by) WHERE authorized_by IS NOT NULL;

-- Job 156: one row per delivered briefing (per business day), so a replayed
-- delivery never shows or emails the same briefing twice.
CREATE TABLE stockchief_runtime.agent_briefing_deliveries (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  report_date date NOT NULL,
  from_date date NOT NULL,
  slot_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('HELD','QUEUED','SENT','FAILED','CANCELLED')),
  hold_reason text CHECK (hold_reason IS NULL OR length(hold_reason)<=500),
  summary jsonb NOT NULL,
  mailbox text,
  recipients text[] NOT NULL DEFAULT '{}',
  communication_ids text[] NOT NULL DEFAULT '{}',
  sent_by_owner boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,report_date),
  CHECK (from_date<=report_date)
);
CREATE INDEX agent_briefing_delivery_queued ON stockchief_runtime.agent_briefing_deliveries(workspace_id,report_date) WHERE status='QUEUED';

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_report_email_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_briefing_deliveries'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY[
    'stockchief_runtime.agent_report_email_settings'::regclass,
    'stockchief_runtime.agent_briefing_deliveries'::regclass]) r;
