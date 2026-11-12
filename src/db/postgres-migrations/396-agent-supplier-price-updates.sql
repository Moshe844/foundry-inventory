-- Job 135: a retained supplier price list updates the exact supplier's future
-- purchase cost. One row per price-list row records what happened to it.
CREATE TABLE stockchief_runtime.agent_supplier_cost_rules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  maximum_basis_points int NOT NULL CHECK (maximum_basis_points BETWEEN 1 AND 500),
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  example_source_id text,
  example_ordinal int,
  revision int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,supplier_id)
);
CREATE INDEX agent_supplier_cost_rule_supplier ON stockchief_runtime.agent_supplier_cost_rules(supplier_id);
CREATE INDEX agent_supplier_cost_rule_owner ON stockchief_runtime.agent_supplier_cost_rules(authorized_by) WHERE authorized_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_supplier_cost_updates (
  workspace_id text NOT NULL,
  source_id text NOT NULL,
  ordinal int NOT NULL,
  status text NOT NULL CHECK (status IN ('REVIEW','HELD','UNCHANGED','APPLIED','KEPT','UNDONE')),
  supplier_item_id text REFERENCES supplier_items(id) ON DELETE SET NULL,
  currency text,
  previous_minor bigint CHECK (previous_minor>=0),
  amount_minor bigint CHECK (amount_minor>=0),
  reason text,
  would_apply boolean NOT NULL DEFAULT false,
  automatic boolean NOT NULL DEFAULT false,
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  rule_revision int,
  review_hash text,
  cost_id text,
  written_at text,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  PRIMARY KEY (workspace_id,source_id,ordinal),
  FOREIGN KEY (workspace_id,source_id,ordinal)
    REFERENCES stockchief_runtime.agent_supplier_price_list_findings(workspace_id,source_id,ordinal) ON DELETE CASCADE,
  CHECK (status NOT IN ('APPLIED','UNDONE') OR (supplier_item_id IS NOT NULL AND previous_minor IS NOT NULL
    AND amount_minor IS NOT NULL AND currency IS NOT NULL AND written_at IS NOT NULL))
);
CREATE INDEX agent_supplier_cost_updates_waiting ON stockchief_runtime.agent_supplier_cost_updates(workspace_id,source_id)
  WHERE status IN ('REVIEW','HELD');
CREATE INDEX agent_supplier_cost_updates_item ON stockchief_runtime.agent_supplier_cost_updates(supplier_item_id)
  WHERE supplier_item_id IS NOT NULL;
CREATE INDEX agent_supplier_cost_updates_person ON stockchief_runtime.agent_supplier_cost_updates(decided_by)
  WHERE decided_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_supplier_cost_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_supplier_cost_updates'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation IN ('stockchief_runtime.agent_supplier_cost_rules'::regclass,'stockchief_runtime.agent_supplier_cost_updates'::regclass);
