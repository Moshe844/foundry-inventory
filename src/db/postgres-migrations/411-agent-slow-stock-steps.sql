-- Job 9: each dead or slow stock finding becomes a concrete next step: a move to
-- a location where the item sells, a supplier return, or a clearance plan.
-- Rules hold the owner's limits for taking a kind of step without a person.
CREATE TABLE stockchief_runtime.agent_slow_stock_rules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('MOVE','RETURN','DISCOUNT')),
  enabled boolean NOT NULL DEFAULT true,
  minimum_days int NOT NULL CHECK (minimum_days BETWEEN 1 AND 3650),
  maximum_quantity numeric(20,6) CHECK (maximum_quantity>0),
  maximum_minor bigint CHECK (maximum_minor>0),
  currency text,
  markdown_points int CHECK (markdown_points BETWEEN 1 AND 9900),
  step_days int CHECK (step_days BETWEEN 1 AND 365),
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  example_step_id text,
  revision int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,kind),
  CHECK (kind<>'MOVE' OR maximum_quantity IS NOT NULL),
  CHECK (kind<>'RETURN' OR (maximum_minor IS NOT NULL AND currency IS NOT NULL)),
  CHECK (kind<>'DISCOUNT' OR (markdown_points IS NOT NULL AND step_days IS NOT NULL))
);
CREATE INDEX agent_slow_stock_rule_owner ON stockchief_runtime.agent_slow_stock_rules(authorized_by) WHERE authorized_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_slow_stock_steps (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('MOVE','RETURN','DISCOUNT')),
  status text NOT NULL CHECK (status IN ('DRAFT','HELD','DONE','DISMISSED','UNDONE')),
  quantity numeric(20,6) NOT NULL CHECK (quantity>0),
  details jsonb NOT NULL,
  fingerprint text NOT NULL,
  reason text,
  would_apply boolean NOT NULL DEFAULT false,
  automatic boolean NOT NULL DEFAULT false,
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  rule_revision int,
  transfer_id text REFERENCES inventory_transfers(id) ON DELETE SET NULL,
  supplier_return_id text REFERENCES supplier_returns(id) ON DELETE SET NULL,
  clearance_plan_id text REFERENCES stockchief_runtime.agent_clearance_plans(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  CHECK (status<>'DONE' OR num_nonnulls(transfer_id,supplier_return_id,clearance_plan_id)=1)
);
CREATE UNIQUE INDEX agent_slow_stock_open_step ON stockchief_runtime.agent_slow_stock_steps(workspace_id,sku_id,location_id,kind)
  WHERE status IN ('DRAFT','HELD');
CREATE INDEX agent_slow_stock_steps_recent ON stockchief_runtime.agent_slow_stock_steps(workspace_id,decided_at DESC,id)
  WHERE status IN ('DONE','UNDONE');
CREATE INDEX agent_slow_stock_steps_undone ON stockchief_runtime.agent_slow_stock_steps(workspace_id,sku_id,location_id,kind,fingerprint)
  WHERE status='UNDONE';
CREATE INDEX agent_slow_stock_steps_sku ON stockchief_runtime.agent_slow_stock_steps(sku_id);
CREATE INDEX agent_slow_stock_steps_location ON stockchief_runtime.agent_slow_stock_steps(location_id);
CREATE INDEX agent_slow_stock_steps_person ON stockchief_runtime.agent_slow_stock_steps(decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX agent_slow_stock_steps_transfer ON stockchief_runtime.agent_slow_stock_steps(transfer_id) WHERE transfer_id IS NOT NULL;
CREATE INDEX agent_slow_stock_steps_return ON stockchief_runtime.agent_slow_stock_steps(supplier_return_id) WHERE supplier_return_id IS NOT NULL;
CREATE INDEX agent_slow_stock_steps_plan ON stockchief_runtime.agent_slow_stock_steps(clearance_plan_id) WHERE clearance_plan_id IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_slow_stock_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_slow_stock_steps'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation IN ('stockchief_runtime.agent_slow_stock_rules'::regclass,'stockchief_runtime.agent_slow_stock_steps'::regclass);
