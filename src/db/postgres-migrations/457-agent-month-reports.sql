-- Jobs 157, 158 and 159: monthly reports StockChief makes on its own.
-- Each report it makes for a month is kept as one run per set of facts, so a
-- replay of the same facts finds the same run. What the owner should look at
-- is kept as a flag in Needs you until a later run of the same month clears it.

CREATE TABLE stockchief_runtime.agent_report_runs (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  job_id integer NOT NULL CHECK (job_id IN (157,158,159)),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  run_key text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('PRODUCED','WATCHED','STOPPED')),
  reason text,
  authorization_kind text NOT NULL CHECK (authorization_kind IN ('AUTOMATIC','INDIVIDUAL')),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,run_key)
);
CREATE INDEX agent_report_run_recent ON stockchief_runtime.agent_report_runs(workspace_id,job_id,period,created_at);
CREATE INDEX agent_report_run_creator ON stockchief_runtime.agent_report_runs(created_by);

CREATE TABLE stockchief_runtime.agent_report_flags (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  job_id integer NOT NULL CHECK (job_id IN (157,158,159)),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  flag_key text NOT NULL CHECK (length(flag_key) BETWEEN 1 AND 200),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  amount_minor bigint,
  detail jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN','DISMISSED','CLEARED')),
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
-- A seen flag stays quiet until a later run of its month clears it.
CREATE UNIQUE INDEX agent_report_flag_current ON stockchief_runtime.agent_report_flags(workspace_id,job_id,flag_key) WHERE status IN ('OPEN','DISMISSED');
CREATE INDEX agent_report_flag_recent ON stockchief_runtime.agent_report_flags(workspace_id,status,updated_at);
CREATE INDEX agent_report_flag_dismisser ON stockchief_runtime.agent_report_flags(dismissed_by);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_report_runs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_report_flags'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY[
    'stockchief_runtime.agent_report_runs'::regclass,
    'stockchief_runtime.agent_report_flags'::regclass]) r;
