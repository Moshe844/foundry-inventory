-- Job 126: finds duplicates, missing cost or weight and bad SKUs, and fixes
-- them in bulk. Each fix is one record: prepared for a person, or made on its
-- own inside the owner's daily limit, then audited and undoable. Rules hold
-- the owner's daily limit for making one kind of fix without a person.
CREATE TABLE stockchief_runtime.agent_catalog_fix_rules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('MERGE','SKU','COST','WEIGHT')),
  enabled boolean NOT NULL DEFAULT true,
  daily_limit int NOT NULL CHECK (daily_limit BETWEEN 1 AND 1000),
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  example_fix_id text,
  revision int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,kind)
);
CREATE INDEX agent_catalog_fix_rule_owner ON stockchief_runtime.agent_catalog_fix_rules(authorized_by) WHERE authorized_by IS NOT NULL;

-- sku_id is the product the fix changes; for a merge it is the duplicate and
-- target_sku_id the product kept. applied holds what the fix changed, so it
-- can be undone exactly.
CREATE TABLE stockchief_runtime.agent_catalog_fixes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('MERGE','SKU','COST','WEIGHT')),
  sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  target_sku_id text REFERENCES skus(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('DRAFT','HELD','DONE','DISMISSED','UNDONE')),
  details jsonb NOT NULL,
  fingerprint text NOT NULL,
  reason text,
  would_apply boolean NOT NULL DEFAULT false,
  automatic boolean NOT NULL DEFAULT false,
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  rule_revision int,
  applied jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  CHECK ((kind='MERGE')=(target_sku_id IS NOT NULL)),
  CHECK (status NOT IN ('DONE','UNDONE') OR applied IS NOT NULL)
);
CREATE UNIQUE INDEX agent_catalog_open_fix ON stockchief_runtime.agent_catalog_fixes(workspace_id,kind,sku_id)
  WHERE status IN ('DRAFT','HELD');
CREATE INDEX agent_catalog_fixes_waiting ON stockchief_runtime.agent_catalog_fixes(workspace_id,status,kind,created_at,id)
  WHERE status IN ('DRAFT','HELD');
CREATE INDEX agent_catalog_fixes_recent ON stockchief_runtime.agent_catalog_fixes(workspace_id,decided_at DESC,id)
  WHERE status IN ('DONE','UNDONE');
CREATE INDEX agent_catalog_fixes_daily ON stockchief_runtime.agent_catalog_fixes(workspace_id,kind,decided_at)
  WHERE status='DONE' AND automatic;
CREATE INDEX agent_catalog_fixes_closed ON stockchief_runtime.agent_catalog_fixes(workspace_id,sku_id,kind,fingerprint)
  WHERE status IN ('DISMISSED','UNDONE');
CREATE INDEX agent_catalog_fixes_merged ON stockchief_runtime.agent_catalog_fixes(workspace_id,target_sku_id)
  WHERE kind='MERGE' AND status='DONE';
CREATE INDEX agent_catalog_fixes_sku ON stockchief_runtime.agent_catalog_fixes(sku_id);
CREATE INDEX agent_catalog_fixes_target ON stockchief_runtime.agent_catalog_fixes(target_sku_id) WHERE target_sku_id IS NOT NULL;
CREATE INDEX agent_catalog_fixes_person ON stockchief_runtime.agent_catalog_fixes(decided_by) WHERE decided_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_catalog_fix_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_catalog_fixes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation IN ('stockchief_runtime.agent_catalog_fix_rules'::regclass,'stockchief_runtime.agent_catalog_fixes'::regclass);
