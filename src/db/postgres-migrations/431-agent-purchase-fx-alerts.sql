-- Job 40: purchases in other currencies.
-- Exchange rates with their date and source, the landed-cost estimate made
-- when a foreign purchase is placed, the rate each foreign receipt was booked
-- at, the owner's alert rule, alert checks and the alerts themselves.

CREATE TABLE stockchief_runtime.agent_fx_rates (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  rate_date date NOT NULL,
  from_currency text NOT NULL CHECK (from_currency ~ '^[A-Z]{3}$'),
  to_currency text NOT NULL CHECK (to_currency ~ '^[A-Z]{3}$' AND to_currency<>from_currency),
  rate text NOT NULL CHECK (rate ~ '^[0-9]{1,20}(\.[0-9]{1,30})?$'),
  source_reference text NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 300),
  recorded_by text REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  PRIMARY KEY (workspace_id,source,rate_date,from_currency,to_currency),
  CHECK ((source='MANUAL')=(recorded_by IS NOT NULL))
);
CREATE INDEX agent_fx_rate_lookup ON stockchief_runtime.agent_fx_rates(workspace_id,to_currency,rate_date);
CREATE INDEX agent_fx_rate_recorder ON stockchief_runtime.agent_fx_rates(recorded_by);

CREATE TABLE stockchief_runtime.agent_fx_order_estimates (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  purchase_order_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  base_currency text NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$' AND base_currency<>currency),
  rate text NOT NULL,
  rate_date date NOT NULL,
  rate_source text NOT NULL,
  goods_minor bigint NOT NULL CHECK (goods_minor>=0),
  estimate_minor bigint NOT NULL CHECK (estimate_minor>=0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,purchase_order_id)
);
CREATE INDEX agent_fx_estimate_order ON stockchief_runtime.agent_fx_order_estimates(purchase_order_id);

CREATE TABLE stockchief_runtime.agent_fx_receipt_rates (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  receipt_id text NOT NULL,
  receipt_line_key text NOT NULL,
  purchase_order_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  purchase_order_line_id text NOT NULL,
  sku_id text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  base_currency text NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$' AND base_currency<>currency),
  foreign_minor bigint NOT NULL CHECK (foreign_minor>=0),
  base_minor bigint NOT NULL CHECK (base_minor>=0),
  rate text NOT NULL,
  rate_date date NOT NULL,
  rate_source text NOT NULL,
  rate_reference text NOT NULL,
  journal_entry_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,receipt_id,receipt_line_key)
);
CREATE INDEX agent_fx_receipt_order ON stockchief_runtime.agent_fx_receipt_rates(purchase_order_id);
CREATE INDEX agent_fx_receipt_item ON stockchief_runtime.agent_fx_receipt_rates(workspace_id,sku_id,currency,created_at);

CREATE TABLE stockchief_runtime.agent_fx_alert_rules (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  threshold_percent numeric(5,2) NOT NULL CHECK (threshold_percent>0 AND threshold_percent<=50),
  email_connector_id text,
  enabled boolean NOT NULL DEFAULT true,
  authorized_by text NOT NULL REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_fx_alert_rule_owner ON stockchief_runtime.agent_fx_alert_rules(authorized_by);

CREATE TABLE stockchief_runtime.agent_fx_runs (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  run_key text NOT NULL,
  rate_date date NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('ALERTED','WATCHED')),
  reason text,
  authorization_kind text NOT NULL CHECK (authorization_kind IN ('AUTOMATIC','INDIVIDUAL')),
  result jsonb NOT NULL,
  created_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,run_key)
);
CREATE INDEX agent_fx_run_recent ON stockchief_runtime.agent_fx_runs(workspace_id,created_at);
CREATE INDEX agent_fx_run_creator ON stockchief_runtime.agent_fx_runs(created_by);

CREATE TABLE stockchief_runtime.agent_fx_alerts (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('ORDER','ITEM')),
  subject_id text NOT NULL,
  label text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  base_currency text NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$' AND base_currency<>currency),
  basis_rate text NOT NULL,
  basis_date date,
  basis_source text NOT NULL,
  current_rate text NOT NULL,
  rate_date date NOT NULL,
  rate_source text NOT NULL,
  basis_minor bigint NOT NULL,
  current_minor bigint NOT NULL,
  impact_minor bigint NOT NULL,
  change_percent numeric(9,2) NOT NULL,
  threshold_percent numeric(5,2) NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN','CLEARED','DISMISSED')),
  opened_run_id text NOT NULL,
  last_run_id text NOT NULL,
  cleared_reason text,
  cleared_at timestamptz,
  dismissed_by text REFERENCES users(id),
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  CHECK (status<>'CLEARED' OR (cleared_at IS NOT NULL AND cleared_reason IS NOT NULL)),
  CHECK (status<>'DISMISSED' OR (dismissed_at IS NOT NULL AND dismissed_by IS NOT NULL))
);
CREATE UNIQUE INDEX agent_fx_alert_open ON stockchief_runtime.agent_fx_alerts(workspace_id,subject_kind,subject_id) WHERE status='OPEN';
CREATE INDEX agent_fx_alert_recent ON stockchief_runtime.agent_fx_alerts(workspace_id,status,updated_at);
CREATE INDEX agent_fx_alert_subject ON stockchief_runtime.agent_fx_alerts(workspace_id,subject_kind,subject_id,updated_at);
CREATE INDEX agent_fx_alert_dismisser ON stockchief_runtime.agent_fx_alerts(dismissed_by);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_fx_rates'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_fx_order_estimates'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_fx_receipt_rates'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_fx_alert_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_fx_runs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_fx_alerts'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY[
    'stockchief_runtime.agent_fx_rates'::regclass,
    'stockchief_runtime.agent_fx_order_estimates'::regclass,
    'stockchief_runtime.agent_fx_receipt_rates'::regclass,
    'stockchief_runtime.agent_fx_alert_rules'::regclass,
    'stockchief_runtime.agent_fx_runs'::regclass,
    'stockchief_runtime.agent_fx_alerts'::regclass]) r;
