-- Jobs 166, 167 and 168: alerts for low stock and stock-outs, the owner's
-- watch rules, and late orders, shipments and invoices.
--
-- The alerts themselves are agent notices. These tables hold how the owner
-- wants each kind of alert sent, and which open alerts were raised and
-- emailed, so a replayed check never raises or emails the same alert twice.

-- Low stock and stock-out alerts are agent notices too. Add job 166 to
-- whatever job list the notice table allows at this point.
DO $$
DECLARE allowed text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO allowed FROM pg_constraint
  WHERE conname='agent_operational_notices_job_id_check' AND conrelid='stockchief_runtime.agent_operational_notices'::regclass;
 IF allowed IS NULL OR position('ARRAY[' IN allowed)=0 THEN
  RAISE EXCEPTION 'The agent notice job list has an unexpected form.';
 END IF;
 IF allowed !~ '\m166\M' THEN
  EXECUTE 'ALTER TABLE stockchief_runtime.agent_operational_notices DROP CONSTRAINT agent_operational_notices_job_id_check, ADD CONSTRAINT agent_operational_notices_job_id_check '
   || replace(allowed,'ARRAY[','ARRAY[166, ');
 END IF;
END $$;

-- One row per alert kind: the connected mailbox the owner chose for email
-- (none means in the app only) and, for low stock, the owner's own alert level
-- for products that have no reorder point.
CREATE TABLE stockchief_runtime.agent_alert_channels (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id smallint NOT NULL CHECK (job_id IN (166,167,168)),
  email_connector_id text,
  low_stock_units numeric(24,6) CHECK (low_stock_units IS NULL OR (job_id=166 AND low_stock_units>=0)),
  email_note text CHECK (email_note IS NULL OR length(email_note)<=500),
  last_communication_id text,
  last_emailed_at timestamptz,
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,job_id)
);
CREATE INDEX agent_alert_channel_owner ON stockchief_runtime.agent_alert_channels(authorized_by) WHERE authorized_by IS NOT NULL;

-- One row while an alert is open. It is removed when the alert clears, so an
-- alert that opens again is raised (and emailed) again.
CREATE TABLE stockchief_runtime.agent_alert_deliveries (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id smallint NOT NULL CHECK (job_id IN (166,167,168)),
  kind text NOT NULL,
  reference text NOT NULL,
  link text NOT NULL,
  raised_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  email_batch text,
  email_communication_id text,
  PRIMARY KEY (workspace_id,job_id,kind,reference,link),
  CHECK ((email_batch IS NULL)=(email_communication_id IS NULL))
);
CREATE INDEX agent_alert_delivery_waiting ON stockchief_runtime.agent_alert_deliveries(workspace_id,job_id,raised_at) WHERE email_batch IS NULL;
CREATE INDEX agent_alert_delivery_batch ON stockchief_runtime.agent_alert_deliveries(workspace_id,email_batch) WHERE email_batch IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_alert_channels'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_alert_deliveries'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY[
    'stockchief_runtime.agent_alert_channels'::regclass,
    'stockchief_runtime.agent_alert_deliveries'::regclass]) r;
