-- Job 85: true net margin per item, channel and customer.
-- The owner's fee terms per sales channel, the owner's lowest acceptable net
-- margin, each scheduled margin check and the margin alerts it keeps open.

CREATE TABLE stockchief_runtime.agent_channel_fee_rules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  channel text NOT NULL CHECK (length(channel) BETWEEN 1 AND 100),
  channel_key text NOT NULL CHECK (channel_key=lower(channel)),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  percent_bps integer NOT NULL CHECK (percent_bps BETWEEN 0 AND 10000),
  fixed_minor bigint NOT NULL CHECK (fixed_minor>=0),
  source_reference text NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT true,
  authorized_by text NOT NULL REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id)
);
CREATE UNIQUE INDEX agent_channel_fee_rule_channel ON stockchief_runtime.agent_channel_fee_rules(workspace_id,channel_key,currency);
CREATE INDEX agent_channel_fee_rule_owner ON stockchief_runtime.agent_channel_fee_rules(authorized_by);

CREATE TABLE stockchief_runtime.agent_net_margin_rules (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  threshold_bps integer NOT NULL CHECK (threshold_bps BETWEEN 1 AND 9999),
  period_days integer NOT NULL CHECK (period_days BETWEEN 7 AND 365),
  enabled boolean NOT NULL DEFAULT true,
  authorized_by text NOT NULL REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_net_margin_rule_owner ON stockchief_runtime.agent_net_margin_rules(authorized_by);

CREATE TABLE stockchief_runtime.agent_net_margin_runs (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  run_key text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('CHECKED','WATCHED','STOPPED')),
  reason text,
  authorization_kind text NOT NULL CHECK (authorization_kind IN ('AUTOMATIC','INDIVIDUAL')),
  result jsonb NOT NULL,
  created_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,run_key)
);
CREATE INDEX agent_net_margin_run_recent ON stockchief_runtime.agent_net_margin_runs(workspace_id,created_at);
CREATE INDEX agent_net_margin_run_creator ON stockchief_runtime.agent_net_margin_runs(created_by);

CREATE TABLE stockchief_runtime.agent_net_margin_alerts (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('ITEM','CHANNEL','CUSTOMER')),
  subject_key text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  label text NOT NULL,
  orders integer NOT NULL CHECK (orders>0),
  revenue_minor bigint NOT NULL,
  net_minor bigint NOT NULL,
  margin_bps integer,
  threshold_bps integer NOT NULL,
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
-- A seen alert stays quiet until its subject is back above the line.
CREATE UNIQUE INDEX agent_net_margin_alert_current ON stockchief_runtime.agent_net_margin_alerts(workspace_id,subject_kind,subject_key,currency) WHERE status IN ('OPEN','DISMISSED');
CREATE INDEX agent_net_margin_alert_recent ON stockchief_runtime.agent_net_margin_alerts(workspace_id,status,updated_at);
CREATE INDEX agent_net_margin_alert_dismisser ON stockchief_runtime.agent_net_margin_alerts(dismissed_by);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_channel_fee_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_net_margin_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_net_margin_runs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_net_margin_alerts'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY[
    'stockchief_runtime.agent_channel_fee_rules'::regclass,
    'stockchief_runtime.agent_net_margin_rules'::regclass,
    'stockchief_runtime.agent_net_margin_runs'::regclass,
    'stockchief_runtime.agent_net_margin_alerts'::regclass]) r;
