-- Job 167: watch rules in plain words. One rule watches any item, or the items
-- of a brand, category, supplier, location or tag, for stock under, over or
-- out, a selling price change, sales above or below a number over a period, or
-- a batch expiring within some days. The owner's own words are kept with the
-- rule StockChief read from them.
CREATE TABLE stockchief_runtime.agent_watch_rules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  instruction text NOT NULL CHECK (length(instruction) BETWEEN 1 AND 320),
  subject_kind text NOT NULL CHECK (subject_kind IN ('ALL','BRAND','CATEGORY','SUPPLIER','LOCATION','TAG')),
  subject_key text NOT NULL DEFAULT '',
  subject_name text NOT NULL DEFAULT '',
  supplier_id text REFERENCES suppliers(id) ON DELETE CASCADE,
  location_id text REFERENCES locations(id) ON DELETE CASCADE,
  condition text NOT NULL CHECK (condition IN ('STOCK_BELOW','STOCK_ABOVE','OUT_OF_STOCK','PRICE_CHANGE','SALES_ABOVE','SALES_BELOW','EXPIRES_WITHIN')),
  amount numeric(24,6) CHECK (amount IS NULL OR amount>=0),
  inclusive boolean NOT NULL DEFAULT false,
  days integer CHECK (days IS NULL OR days BETWEEN 1 AND 3650),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((subject_kind='SUPPLIER')=(supplier_id IS NOT NULL)),
  CHECK ((subject_kind='LOCATION')=(location_id IS NOT NULL)),
  CHECK ((condition IN ('STOCK_BELOW','STOCK_ABOVE','SALES_ABOVE','SALES_BELOW'))=(amount IS NOT NULL)),
  CHECK ((condition IN ('PRICE_CHANGE','SALES_ABOVE','SALES_BELOW','EXPIRES_WITHIN'))=(days IS NOT NULL))
);
-- One rule per thing watched and condition; saving it again changes that rule.
CREATE UNIQUE INDEX agent_watch_rule_scope ON stockchief_runtime.agent_watch_rules(workspace_id,subject_kind,subject_key,condition) WHERE enabled;
CREATE INDEX agent_watch_rule_supplier ON stockchief_runtime.agent_watch_rules(supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX agent_watch_rule_location ON stockchief_runtime.agent_watch_rules(location_id) WHERE location_id IS NOT NULL;
CREATE INDEX agent_watch_rule_creator ON stockchief_runtime.agent_watch_rules(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX agent_watch_rule_editor ON stockchief_runtime.agent_watch_rules(updated_by) WHERE updated_by IS NOT NULL;

-- Brand watches saved before become watch rules, and leave the old table so a
-- rule is never counted twice against the plan's rule allowance.
INSERT INTO stockchief_runtime.agent_watch_rules(id,workspace_id,instruction,subject_kind,subject_key,subject_name,condition,amount,inclusive,created_by,updated_by)
  SELECT 'watch-'||md5(workspace_id||':'||brand_key),workspace_id,
    left('Tell me if any '||brand_name||' item '||CASE WHEN inclusive THEN 'is at or below ' ELSE 'drops under ' END||trim_scale(threshold)::text,320),
    'BRAND',brand_key,brand_name,'STOCK_BELOW',threshold,inclusive,updated_by,updated_by
  FROM stockchief_runtime.agent_brand_watches;
DELETE FROM stockchief_runtime.agent_brand_watches;

INSERT INTO commercial_storage_tables(relation,bytes_expression)
  VALUES('stockchief_runtime.agent_watch_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.agent_watch_rules'::regclass,true FROM workspaces;
