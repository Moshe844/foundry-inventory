-- Job 131: categories and tags for new products. Each record is one change for
-- one product: a category, or tags to add. A clear one is made on its own inside
-- the owner's daily limit; an unclear one waits as a suggestion. applied holds
-- exactly what changed, so it can be undone.
CREATE TABLE stockchief_runtime.agent_product_classification_rules (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  daily_limit int NOT NULL CHECK (daily_limit BETWEEN 1 AND 5000),
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  revision int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_product_classification_rule_owner ON stockchief_runtime.agent_product_classification_rules(authorized_by) WHERE authorized_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_product_classifications (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('CATEGORY','TAGS')),
  status text NOT NULL CHECK (status IN ('SUGGESTED','DONE','DISMISSED','UNDONE')),
  clear boolean NOT NULL,
  details jsonb NOT NULL,
  fingerprint text NOT NULL,
  reason text,
  would_apply boolean NOT NULL DEFAULT false,
  automatic boolean NOT NULL DEFAULT false,
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  applied jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  CHECK (status NOT IN ('DONE','UNDONE') OR applied IS NOT NULL)
);
CREATE UNIQUE INDEX agent_product_classification_open ON stockchief_runtime.agent_product_classifications(workspace_id,item_id,kind)
  WHERE status='SUGGESTED';
CREATE INDEX agent_product_classifications_waiting ON stockchief_runtime.agent_product_classifications(workspace_id,created_at,id)
  WHERE status='SUGGESTED';
CREATE INDEX agent_product_classifications_recent ON stockchief_runtime.agent_product_classifications(workspace_id,decided_at DESC,id)
  WHERE status IN ('DONE','UNDONE');
CREATE INDEX agent_product_classifications_daily ON stockchief_runtime.agent_product_classifications(workspace_id,decided_at)
  WHERE status='DONE' AND automatic;
CREATE INDEX agent_product_classifications_closed ON stockchief_runtime.agent_product_classifications(workspace_id,item_id,kind,fingerprint)
  WHERE status IN ('DISMISSED','UNDONE');
CREATE INDEX agent_product_classifications_item ON stockchief_runtime.agent_product_classifications(item_id);
CREATE INDEX agent_product_classifications_person ON stockchief_runtime.agent_product_classifications(decided_by) WHERE decided_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_product_classification_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_product_classifications'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation IN ('stockchief_runtime.agent_product_classification_rules'::regclass,'stockchief_runtime.agent_product_classifications'::regclass);
