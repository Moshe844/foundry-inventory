-- Job 144: one current forecast per product from its own recorded sales,
-- with yearly and weekday patterns. A daily worker run refreshes them. The
-- run decides whether each forecast drives planning (USED), waits for the
-- owner (PROPOSED), or is only shown (WATCHED). The owner can keep any product
-- on plain sales history instead (EXCLUDED). Weekly forecasts are also kept in
-- demand_forecasts and scored against actual sales in forecast_outcomes.
CREATE TABLE stockchief_runtime.agent_demand_forecast_runs (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 run_key text NOT NULL,
 business_date date NOT NULL,
 plan text NOT NULL,
 level text NOT NULL CHECK(level IN('watch','draft','alone')),
 requested_by text REFERENCES users(id) ON DELETE SET NULL,
 cursor text,
 counts jsonb NOT NULL DEFAULT '{}'::jsonb,
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 UNIQUE(workspace_id,run_key)
);
CREATE INDEX agent_demand_forecast_run_recent ON stockchief_runtime.agent_demand_forecast_runs(workspace_id,started_at DESC,id);
CREATE INDEX agent_demand_forecast_run_requester ON stockchief_runtime.agent_demand_forecast_runs(requested_by) WHERE requested_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_demand_forecasts (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
 run_id text REFERENCES stockchief_runtime.agent_demand_forecast_runs(id) ON DELETE SET NULL,
 as_of date NOT NULL,
 status text NOT NULL CHECK(status IN('USED','PROPOSED','WATCHED','EXCLUDED','HELD')),
 reason text,
 method text,
 method_label text,
 shape jsonb,
 next_7 numeric,
 next_30 numeric,
 holdout_error numeric,
 baseline_error numeric,
 history_days integer NOT NULL DEFAULT 0,
 order_days integer NOT NULL DEFAULT 0,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 approved_method text,
 approved_next_30 numeric,
 approved_by text REFERENCES users(id) ON DELETE SET NULL,
 approved_at timestamptz,
 excluded_by text REFERENCES users(id) ON DELETE SET NULL,
 excluded_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,sku_id),
 CHECK((status='USED')<=(shape IS NOT NULL)),
 CHECK((status='EXCLUDED')=(excluded_at IS NOT NULL))
);
CREATE INDEX agent_demand_forecast_status ON stockchief_runtime.agent_demand_forecasts(workspace_id,status,sku_id);
CREATE INDEX agent_demand_forecast_sku ON stockchief_runtime.agent_demand_forecasts(sku_id);
CREATE INDEX agent_demand_forecast_run ON stockchief_runtime.agent_demand_forecasts(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX agent_demand_forecast_approver ON stockchief_runtime.agent_demand_forecasts(approved_by) WHERE approved_by IS NOT NULL;
CREATE INDEX agent_demand_forecast_excluder ON stockchief_runtime.agent_demand_forecasts(excluded_by) WHERE excluded_by IS NOT NULL;

-- One stored weekly forecast per product and day, so a replayed run cannot
-- record the same prediction twice.
CREATE UNIQUE INDEX demand_forecasts_agent_weekly ON demand_forecasts(workspace_id,sku_id,as_of)
 WHERE model_version='agent-144-v1' AND location_id IS NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_demand_forecast_runs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_demand_forecasts'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_demand_forecast_runs'::regclass,'stockchief_runtime.agent_demand_forecasts'::regclass);
