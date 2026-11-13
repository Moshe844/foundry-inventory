-- Job 36 (Growth asks, Pro and Custom alone): key suppliers get our stock and a
-- 12-week forecast of their own products every week.
--
-- A key supplier is the existing weekly rule, one per supplier, now chosen by
-- the owner on every plan that has the job. The mailbox forecasts are sent
-- from is the owner's one choice for the job (or the only mailbox connected),
-- so a rule no longer names one.
ALTER TABLE stockchief_runtime.agent_supplier_forecast_rules ALTER COLUMN connector_id DROP NOT NULL;

-- One forecast per key supplier and week. WATCHED: kept while StockChief only
-- watches. WAITING: the owner presses send. STOPPED: a fact is missing
-- (problem). QUEUED: handed to the mailbox; the message records whether it
-- went. Older one-off previews keep a NULL status and are not shown.
ALTER TABLE stockchief_runtime.agent_supplier_forecast_reports
  ALTER COLUMN connector_id DROP NOT NULL,
  ADD COLUMN rule_id text REFERENCES stockchief_runtime.agent_supplier_forecast_rules(id) ON DELETE SET NULL,
  ADD COLUMN status text CHECK (status IS NULL OR status IN ('WATCHED','WAITING','STOPPED','QUEUED')),
  ADD COLUMN reason text CHECK (reason IS NULL OR length(reason)<=500),
  ADD COLUMN problem text CHECK (problem IS NULL OR problem IN ('recipient','products','mailbox','mailbox_choice')),
  ADD COLUMN recipient text,
  ADD COLUMN attempt integer NOT NULL DEFAULT 0 CHECK (attempt>=0),
  ADD COLUMN authorization_kind text CHECK (authorization_kind IS NULL OR authorization_kind IN ('AUTOMATIC','INDIVIDUAL')),
  ADD COLUMN sent_by text REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN queued_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CHECK (status IS DISTINCT FROM 'QUEUED' OR (communication_id IS NOT NULL AND recipient IS NOT NULL AND connector_id IS NOT NULL AND authorization_kind IS NOT NULL)),
  ADD CHECK (status IS DISTINCT FROM 'STOPPED' OR (reason IS NOT NULL AND problem IS NOT NULL));
CREATE UNIQUE INDEX agent_supplier_forecast_reports_week ON stockchief_runtime.agent_supplier_forecast_reports(workspace_id,supplier_id,week_start) WHERE status IS NOT NULL;
CREATE INDEX agent_supplier_forecast_reports_rule ON stockchief_runtime.agent_supplier_forecast_reports(rule_id) WHERE rule_id IS NOT NULL;
CREATE INDEX agent_supplier_forecast_reports_sender ON stockchief_runtime.agent_supplier_forecast_reports(sent_by) WHERE sent_by IS NOT NULL;

-- The owner's mailbox choice for supplier forecasts.
CREATE TABLE stockchief_runtime.agent_supplier_forecast_settings (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id text,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_supplier_forecast_settings_owner ON stockchief_runtime.agent_supplier_forecast_settings(updated_by);
-- An inventory whose weekly sharing used one mailbox keeps it as the choice.
INSERT INTO stockchief_runtime.agent_supplier_forecast_settings(workspace_id,connector_id,updated_by)
  SELECT workspace_id,min(connector_id),min(authorized_by) FROM stockchief_runtime.agent_supplier_forecast_rules
  WHERE enabled AND connector_id IS NOT NULL GROUP BY workspace_id HAVING count(DISTINCT connector_id)=1;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_supplier_forecast_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.agent_supplier_forecast_settings'::regclass,true FROM workspaces;
