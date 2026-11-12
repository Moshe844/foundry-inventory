-- Job 146: one forecast per new product, from similar items chosen by explicit
-- rules or by a person, blended with the product's own early sales. The daily
-- forecast run (job 144) keeps it current. ASK means no clear similar item:
-- StockChief waits for a person to choose one.
CREATE TABLE stockchief_runtime.agent_launch_forecasts (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
 run_id text REFERENCES stockchief_runtime.agent_demand_forecast_runs(id) ON DELETE SET NULL,
 as_of date NOT NULL,
 status text NOT NULL CHECK(status IN('USED','PROPOSED','WATCHED','SUGGESTED','ASK')),
 reason text,
 rule text CHECK(rule IN('RULES','OWNER')),
 comparisons jsonb NOT NULL DEFAULT '[]'::jsonb,
 reference_sku_id text REFERENCES skus(id) ON DELETE SET NULL,
 analog_30 numeric,
 own_days integer NOT NULL DEFAULT 0,
 own_units numeric NOT NULL DEFAULT 0,
 weight numeric,
 daily_rate numeric,
 shape jsonb,
 next_30 numeric,
 chosen_sku_id text REFERENCES skus(id) ON DELETE SET NULL,
 chosen_by text REFERENCES users(id) ON DELETE SET NULL,
 chosen_at timestamptz,
 approved_reference text,
 approved_next_30 numeric,
 approved_by text REFERENCES users(id) ON DELETE SET NULL,
 approved_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,sku_id),
 CHECK((status='USED')<=(shape IS NOT NULL)),
 CHECK((status='ASK')=(shape IS NULL))
);
CREATE INDEX agent_launch_forecast_status ON stockchief_runtime.agent_launch_forecasts(workspace_id,status,sku_id);
CREATE INDEX agent_launch_forecast_sku ON stockchief_runtime.agent_launch_forecasts(sku_id);
CREATE INDEX agent_launch_forecast_run ON stockchief_runtime.agent_launch_forecasts(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX agent_launch_forecast_reference ON stockchief_runtime.agent_launch_forecasts(reference_sku_id) WHERE reference_sku_id IS NOT NULL;
CREATE INDEX agent_launch_forecast_chosen ON stockchief_runtime.agent_launch_forecasts(chosen_sku_id) WHERE chosen_sku_id IS NOT NULL;
CREATE INDEX agent_launch_forecast_chooser ON stockchief_runtime.agent_launch_forecasts(chosen_by) WHERE chosen_by IS NOT NULL;
CREATE INDEX agent_launch_forecast_approver ON stockchief_runtime.agent_launch_forecasts(approved_by) WHERE approved_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_launch_forecasts'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation='stockchief_runtime.agent_launch_forecasts'::regclass;
