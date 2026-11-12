-- Job 86: a clearance plan per item. It suggests markdown steps with the units
-- and cash each step should bring back. A person approves every price; the
-- approved price goes through the normal catalogue price path and the plan
-- tracks recorded sales against what it expected.
CREATE TABLE stockchief_runtime.agent_clearance_plans (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('DRAFT','ACTIVE','ENDED','CANCELLED')),
  request_key text NOT NULL,
  currency text NOT NULL,
  original_price_id text NOT NULL,
  original_price_minor bigint NOT NULL CHECK (original_price_minor>0),
  unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor>=0),
  units numeric(20,6) NOT NULL CHECK (units>0),
  step_days int NOT NULL CHECK (step_days BETWEEN 1 AND 365),
  steps jsonb NOT NULL,
  evidence jsonb NOT NULL,
  evidence_hash text NOT NULL,
  expected_cash_minor bigint NOT NULL CHECK (expected_cash_minor>=0),
  current_step int NOT NULL DEFAULT 0 CHECK (current_step>=0),
  current_price_id text,
  automatic boolean NOT NULL DEFAULT false,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  ended_by text REFERENCES users(id) ON DELETE SET NULL,
  restored_price_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  ended_at timestamptz,
  revision int NOT NULL DEFAULT 1,
  UNIQUE (workspace_id,request_key),
  CHECK (status<>'ACTIVE' OR (current_step>0 AND current_price_id IS NOT NULL AND started_at IS NOT NULL))
);
CREATE UNIQUE INDEX agent_clearance_plans_open ON stockchief_runtime.agent_clearance_plans(workspace_id,sku_id)
  WHERE status IN ('DRAFT','ACTIVE');
CREATE INDEX agent_clearance_plans_recent ON stockchief_runtime.agent_clearance_plans(workspace_id,created_at DESC,id);
CREATE INDEX agent_clearance_plans_sku ON stockchief_runtime.agent_clearance_plans(sku_id);
CREATE INDEX agent_clearance_plans_creator ON stockchief_runtime.agent_clearance_plans(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX agent_clearance_plans_ender ON stockchief_runtime.agent_clearance_plans(ended_by) WHERE ended_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_clearance_plans'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation='stockchief_runtime.agent_clearance_plans'::regclass;
