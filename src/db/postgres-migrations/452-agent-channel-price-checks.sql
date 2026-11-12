-- Job 87: each scheduled check of channel prices against the catalogue price
-- and the owner's minimum advertised price, and the flags it keeps open.

CREATE TABLE stockchief_runtime.agent_channel_price_runs (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  run_key text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('CHECKED','WATCHED','STOPPED')),
  reason text,
  authorization_kind text NOT NULL CHECK (authorization_kind IN ('AUTOMATIC','INDIVIDUAL')),
  result jsonb NOT NULL,
  created_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,run_key)
);
CREATE INDEX agent_channel_price_run_recent ON stockchief_runtime.agent_channel_price_runs(workspace_id,created_at);
CREATE INDEX agent_channel_price_run_creator ON stockchief_runtime.agent_channel_price_runs(created_by);

CREATE TABLE stockchief_runtime.agent_channel_price_alerts (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  scope text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('MAP_BREAK','MISMATCH')),
  label text NOT NULL,
  finding text NOT NULL,
  channel_minor bigint NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  compared_minor bigint,
  status text NOT NULL CHECK (status IN ('OPEN','CLEARED')),
  opened_run_id text NOT NULL,
  last_run_id text NOT NULL,
  cleared_reason text,
  cleared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  CHECK (status<>'CLEARED' OR (cleared_at IS NOT NULL AND cleared_reason IS NOT NULL))
);
CREATE UNIQUE INDEX agent_channel_price_alert_open ON stockchief_runtime.agent_channel_price_alerts(workspace_id,sku_id,connector_id,scope) WHERE status='OPEN';
CREATE INDEX agent_channel_price_alert_recent ON stockchief_runtime.agent_channel_price_alerts(workspace_id,status,updated_at);
CREATE INDEX agent_channel_price_alert_sku ON stockchief_runtime.agent_channel_price_alerts(sku_id);
CREATE INDEX agent_channel_price_alert_connector ON stockchief_runtime.agent_channel_price_alerts(connector_id);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_channel_price_runs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_channel_price_alerts'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY[
    'stockchief_runtime.agent_channel_price_runs'::regclass,
    'stockchief_runtime.agent_channel_price_alerts'::regclass]) r;
