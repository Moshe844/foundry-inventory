-- Job 151: when each item will run out, and what running out costs. A daily
-- worker run keeps one current estimate per item: usable stock after open
-- orders, the forecast, dated purchase orders, the next delivery, gross margin
-- lost per day and the customer orders that would wait.
CREATE TABLE stockchief_runtime.agent_runout_runs (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 run_key text NOT NULL,
 business_date date NOT NULL,
 plan text NOT NULL,
 requested_by text REFERENCES users(id) ON DELETE SET NULL,
 cursor text,
 counts jsonb NOT NULL DEFAULT '{}'::jsonb,
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 UNIQUE(workspace_id,run_key)
);
CREATE INDEX agent_runout_run_recent ON stockchief_runtime.agent_runout_runs(workspace_id,started_at DESC,id);
CREATE INDEX agent_runout_run_requester ON stockchief_runtime.agent_runout_runs(requested_by) WHERE requested_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_runout_estimates (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
 run_id text REFERENCES stockchief_runtime.agent_runout_runs(id) ON DELETE SET NULL,
 as_of date NOT NULL,
 available numeric NOT NULL,
 waiting numeric NOT NULL DEFAULT 0,
 daily_demand numeric,
 demand_basis text NOT NULL CHECK(demand_basis IN ('FORECAST','HISTORY','NONE')),
 demand_label text,
 runout_date date,
 next_delivery_date date,
 next_delivery text,
 before_delivery boolean NOT NULL DEFAULT false,
 days_short integer,
 units_short numeric,
 currency text,
 unit_margin_minor bigint,
 daily_margin_minor bigint,
 lost_margin_minor bigint,
 orders_affected integer NOT NULL DEFAULT 0,
 reason text,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,sku_id)
);
CREATE INDEX agent_runout_estimate_flagged ON stockchief_runtime.agent_runout_estimates(workspace_id,before_delivery,lost_margin_minor DESC NULLS LAST,sku_id);
CREATE INDEX agent_runout_estimate_date ON stockchief_runtime.agent_runout_estimates(workspace_id,runout_date,sku_id);
CREATE INDEX agent_runout_estimate_sku ON stockchief_runtime.agent_runout_estimates(sku_id);
CREATE INDEX agent_runout_estimate_run ON stockchief_runtime.agent_runout_estimates(run_id) WHERE run_id IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_runout_runs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_runout_estimates'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_runout_runs'::regclass,'stockchief_runtime.agent_runout_estimates'::regclass);
