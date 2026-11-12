-- Job 150: safety stock set from how often the owner can afford to run out.
-- A target belongs to an A, B or C product class, at one location or at all
-- locations (no location). It is either a percentage of reorders that must
-- not run out, or how many times a year running out is acceptable.
ALTER TABLE stockchief_runtime.class_service_levels DROP CONSTRAINT class_service_levels_pkey;
ALTER TABLE stockchief_runtime.class_service_levels ALTER COLUMN location_id DROP NOT NULL;
ALTER TABLE stockchief_runtime.class_service_levels ALTER COLUMN service_level TYPE numeric USING service_level::numeric;
ALTER TABLE stockchief_runtime.class_service_levels ALTER COLUMN service_level DROP NOT NULL;
ALTER TABLE stockchief_runtime.class_service_levels ADD COLUMN runouts_per_year numeric CHECK(runouts_per_year>0 AND runouts_per_year<=52);
ALTER TABLE stockchief_runtime.class_service_levels ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE stockchief_runtime.class_service_levels ADD CONSTRAINT class_service_levels_one_target
 CHECK((service_level IS NULL)<>(runouts_per_year IS NULL));
CREATE UNIQUE INDEX class_service_levels_scope ON stockchief_runtime.class_service_levels(workspace_id,(coalesce(location_id,'')),class);
CREATE INDEX class_service_levels_location ON stockchief_runtime.class_service_levels(location_id) WHERE location_id IS NOT NULL;
CREATE INDEX class_service_levels_owner ON stockchief_runtime.class_service_levels(authorized_by);

-- Each safety stock value the daily forecast run works out for a product and
-- location (or all locations): applied on its own, waiting for a person,
-- only shown, or held with the reason. Applied values keep the earlier one
-- for undo.
CREATE TABLE stockchief_runtime.agent_safety_stock_changes (
 id text PRIMARY KEY,
 run_id text REFERENCES stockchief_runtime.agent_demand_forecast_runs(id) ON DELETE SET NULL,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
 location_id text REFERENCES locations(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('WATCHED','DRAFT','APPLIED','DECLINED','UNDONE','REPLACED','HELD')),
 reason text,
 before_safety numeric(20,6),
 before_source text,
 after_safety numeric(20,6),
 change_percent numeric(12,2),
 value_key text,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 authority text CHECK(authority IN ('RULE','PERSON')),
 rule_revision integer,
 policy_id text REFERENCES reorder_policies(id) ON DELETE SET NULL,
 created_policy boolean NOT NULL DEFAULT false,
 decided_by text REFERENCES users(id) ON DELETE SET NULL,
 decided_at timestamptz,
 undone_by text REFERENCES users(id) ON DELETE SET NULL,
 undone_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status='APPLIED' OR status='UNDONE')=(authority IS NOT NULL)),
 CHECK((status='UNDONE')=(undone_at IS NOT NULL))
);
CREATE UNIQUE INDEX agent_safety_stock_change_position ON stockchief_runtime.agent_safety_stock_changes(run_id,sku_id,(coalesce(location_id,'')))
 WHERE run_id IS NOT NULL;
CREATE INDEX agent_safety_stock_change_open ON stockchief_runtime.agent_safety_stock_changes(workspace_id,status,created_at DESC,id);
CREATE INDEX agent_safety_stock_change_history ON stockchief_runtime.agent_safety_stock_changes(workspace_id,sku_id,location_id,created_at DESC);
CREATE INDEX agent_safety_stock_change_run ON stockchief_runtime.agent_safety_stock_changes(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX agent_safety_stock_change_sku ON stockchief_runtime.agent_safety_stock_changes(sku_id);
CREATE INDEX agent_safety_stock_change_location ON stockchief_runtime.agent_safety_stock_changes(location_id) WHERE location_id IS NOT NULL;
CREATE INDEX agent_safety_stock_change_policy ON stockchief_runtime.agent_safety_stock_changes(policy_id) WHERE policy_id IS NOT NULL;
CREATE INDEX agent_safety_stock_change_decider ON stockchief_runtime.agent_safety_stock_changes(decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX agent_safety_stock_change_undoer ON stockchief_runtime.agent_safety_stock_changes(undone_by) WHERE undone_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_safety_stock_changes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,'stockchief_runtime.agent_safety_stock_changes'::regclass,true FROM workspaces w;
