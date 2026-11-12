-- Job 132: one retirement per discontinued product (SKU), whatever said so: a
-- checked supplier notice, the owner, or the owner's dead-stock rule. While a
-- retirement is open the product is never reordered. Stock left on hand is
-- sold down (with a job 86 clearance plan when one applies); a person decides
-- any write-off. With no stock and no open work the product is archived and
-- its channel stock set to zero. applied holds what changed, so it can be undone.
ALTER TABLE stockchief_runtime.agent_product_replacements ALTER COLUMN notice_id DROP NOT NULL;

CREATE TABLE stockchief_runtime.agent_product_retirements (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  replacement_sku_id text REFERENCES skus(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('SUPPLIER','OWNER','DEAD_STOCK')),
  notice_id text REFERENCES stockchief_runtime.agent_product_retirement_notices(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('DRAFT','SELLING_DOWN','RETIRED','DISMISSED','UNDONE')),
  automatic boolean NOT NULL DEFAULT false,
  reason text,
  evidence jsonb NOT NULL DEFAULT '{}',
  fingerprint text NOT NULL,
  applied jsonb NOT NULL DEFAULT '{}',
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  retired_at timestamptz,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (replacement_sku_id IS NULL OR replacement_sku_id<>sku_id)
);
CREATE UNIQUE INDEX agent_product_retirement_open ON stockchief_runtime.agent_product_retirements(workspace_id,sku_id)
  WHERE status IN ('DRAFT','SELLING_DOWN','RETIRED');
CREATE INDEX agent_product_retirements_working ON stockchief_runtime.agent_product_retirements(workspace_id,status,created_at,id)
  WHERE status IN ('DRAFT','SELLING_DOWN');
CREATE INDEX agent_product_retirements_recent ON stockchief_runtime.agent_product_retirements(workspace_id,created_at DESC,id);
CREATE INDEX agent_product_retirements_closed ON stockchief_runtime.agent_product_retirements(workspace_id,sku_id,fingerprint)
  WHERE status IN ('DISMISSED','UNDONE');
CREATE INDEX agent_product_retirements_sku ON stockchief_runtime.agent_product_retirements(sku_id);
CREATE INDEX agent_product_retirements_item ON stockchief_runtime.agent_product_retirements(item_id);
CREATE INDEX agent_product_retirements_replacement ON stockchief_runtime.agent_product_retirements(replacement_sku_id) WHERE replacement_sku_id IS NOT NULL;
CREATE INDEX agent_product_retirements_notice ON stockchief_runtime.agent_product_retirements(notice_id) WHERE notice_id IS NOT NULL;
CREATE INDEX agent_product_retirements_creator ON stockchief_runtime.agent_product_retirements(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX agent_product_retirements_person ON stockchief_runtime.agent_product_retirements(decided_by) WHERE decided_by IS NOT NULL;

-- Products already retired from a checked notice keep their guidance.
INSERT INTO stockchief_runtime.agent_product_retirements(id,workspace_id,sku_id,item_id,replacement_sku_id,source,notice_id,status,automatic,
  fingerprint,applied,decided_by,decided_at,retired_at,created_at)
SELECT 'retirement-'||r.old_sku_id,r.workspace_id,r.old_sku_id,s.item_id,r.replacement_sku_id,'SUPPLIER',r.notice_id,'RETIRED',coalesce(n.automatic,false),
  'notice:'||r.notice_id,jsonb_build_object('archived',CASE WHEN i.is_active=0 THEN 'item' ELSE 'sku' END,'before',true),n.applied_by,n.applied_at,n.applied_at,r.created_at
FROM stockchief_runtime.agent_product_replacements r JOIN skus s ON s.id=r.old_sku_id JOIN items i ON i.id=s.item_id
LEFT JOIN stockchief_runtime.agent_product_retirement_notices n ON n.id=r.notice_id
WHERE s.is_active=0;

-- The owner's dead-stock rule and the clearance markdown used for stock left
-- on discontinued products. example_id is the completed retirement that
-- taught Pro to retire dead stock on its own.
CREATE TABLE stockchief_runtime.agent_product_retirement_rules (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  dead_days int NOT NULL CHECK (dead_days BETWEEN 30 AND 1095),
  daily_limit int NOT NULL CHECK (daily_limit BETWEEN 1 AND 100),
  markdown_points int CHECK (markdown_points BETWEEN 1 AND 9900),
  step_days int CHECK (step_days BETWEEN 1 AND 365),
  example_id text REFERENCES stockchief_runtime.agent_product_retirements(id) ON DELETE SET NULL,
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  revision int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((markdown_points IS NULL)=(step_days IS NULL))
);
CREATE INDEX agent_product_retirement_rules_example ON stockchief_runtime.agent_product_retirement_rules(example_id) WHERE example_id IS NOT NULL;
CREATE INDEX agent_product_retirement_rules_owner ON stockchief_runtime.agent_product_retirement_rules(authorized_by) WHERE authorized_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_product_retirements'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_product_retirement_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation IN ('stockchief_runtime.agent_product_retirements'::regclass,'stockchief_runtime.agent_product_retirement_rules'::regclass);
