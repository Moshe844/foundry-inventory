-- Job 207: the owner writes "always order X from Acme" or "never order X from
-- Beta" in plain words. X is one SKU, a product (all its variants), a
-- category, or everything. Reorder drafts and automatic reorders only use the
-- suppliers these rules allow, and stop and ask when no supplier is left.
-- Each enabled rule is one saved rule in the plan's allowance.
CREATE TABLE stockchief_runtime.agent_supplier_choice_rules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  instruction text NOT NULL CHECK (length(instruction) BETWEEN 1 AND 320),
  choice text NOT NULL CHECK (choice IN ('ALWAYS','NEVER')),
  scope_kind text NOT NULL CHECK (scope_kind IN ('ALL','SKU','ITEM','CATEGORY')),
  scope_name text NOT NULL DEFAULT '',
  sku_id text REFERENCES skus(id) ON DELETE CASCADE,
  item_id text REFERENCES items(id) ON DELETE CASCADE,
  category_key text,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((scope_kind='SKU')=(sku_id IS NOT NULL) AND (scope_kind='ITEM')=(item_id IS NOT NULL)
    AND (scope_kind='CATEGORY')=(category_key IS NOT NULL AND category_key<>''))
);
CREATE UNIQUE INDEX agent_supplier_choice_rules_scope ON stockchief_runtime.agent_supplier_choice_rules
  (workspace_id,scope_kind,coalesce(sku_id,''),coalesce(item_id,''),coalesce(category_key,''),supplier_id) WHERE enabled;
CREATE INDEX agent_supplier_choice_rules_workspace ON stockchief_runtime.agent_supplier_choice_rules(workspace_id) WHERE enabled;
CREATE INDEX agent_supplier_choice_rules_sku ON stockchief_runtime.agent_supplier_choice_rules(sku_id) WHERE sku_id IS NOT NULL;
CREATE INDEX agent_supplier_choice_rules_item ON stockchief_runtime.agent_supplier_choice_rules(item_id) WHERE item_id IS NOT NULL;
CREATE INDEX agent_supplier_choice_rules_supplier ON stockchief_runtime.agent_supplier_choice_rules(supplier_id);
CREATE INDEX agent_supplier_choice_rules_creator ON stockchief_runtime.agent_supplier_choice_rules(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX agent_supplier_choice_rules_updater ON stockchief_runtime.agent_supplier_choice_rules(updated_by) WHERE updated_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_supplier_choice_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation='stockchief_runtime.agent_supplier_choice_rules'::regclass;
