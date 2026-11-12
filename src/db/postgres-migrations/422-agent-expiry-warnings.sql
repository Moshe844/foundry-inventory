-- Job 191: warns before stock expires and suggests where to sell it first.
-- The owner chooses how many days ahead to be warned, for every product, for a
-- category or for one product. The most specific choice wins.
CREATE TABLE stockchief_runtime.agent_expiry_warning_rules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('ALL','CATEGORY','ITEM')),
  item_id text REFERENCES items(id) ON DELETE CASCADE,
  category text CHECK (category IS NULL OR length(category) BETWEEN 1 AND 160),
  warning_days int NOT NULL CHECK (warning_days BETWEEN 1 AND 3650),
  enabled boolean NOT NULL DEFAULT true,
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  revision int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((scope='ALL' AND item_id IS NULL AND category IS NULL)
    OR (scope='CATEGORY' AND item_id IS NULL AND category IS NOT NULL)
    OR (scope='ITEM' AND item_id IS NOT NULL AND category IS NULL))
);
CREATE UNIQUE INDEX agent_expiry_warning_rule_scope ON stockchief_runtime.agent_expiry_warning_rules
  (workspace_id,scope,coalesce(item_id,''),coalesce(category,''));
CREATE INDEX agent_expiry_warning_rule_item ON stockchief_runtime.agent_expiry_warning_rules(item_id) WHERE item_id IS NOT NULL;
CREATE INDEX agent_expiry_warning_rule_owner ON stockchief_runtime.agent_expiry_warning_rules(authorized_by) WHERE authorized_by IS NOT NULL;

-- One warning per batch at one location and expiry date. The sell-first plan
-- is refreshed every time the routine checks; a person can mark it handled.
CREATE TABLE stockchief_runtime.agent_expiry_warnings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lot_id text NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  expires_on date NOT NULL,
  warning_days int NOT NULL CHECK (warning_days BETWEEN 1 AND 3650),
  units numeric(20,6) NOT NULL CHECK (units>0),
  plan jsonb NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN','HANDLED','CLEARED')),
  expired boolean NOT NULL DEFAULT false,
  email_note text,
  email_communication_id text,
  emailed_at timestamptz,
  handled_by text REFERENCES users(id) ON DELETE SET NULL,
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id,lot_id,location_id,expires_on)
);
CREATE INDEX agent_expiry_warnings_open ON stockchief_runtime.agent_expiry_warnings(workspace_id,expires_on,id) WHERE status='OPEN';
CREATE INDEX agent_expiry_warnings_lot ON stockchief_runtime.agent_expiry_warnings(lot_id);
CREATE INDEX agent_expiry_warnings_sku ON stockchief_runtime.agent_expiry_warnings(sku_id);
CREATE INDEX agent_expiry_warnings_location ON stockchief_runtime.agent_expiry_warnings(location_id);
CREATE INDEX agent_expiry_warnings_person ON stockchief_runtime.agent_expiry_warnings(handled_by) WHERE handled_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_expiry_warning_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_expiry_warnings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation IN ('stockchief_runtime.agent_expiry_warning_rules'::regclass,'stockchief_runtime.agent_expiry_warnings'::regclass);
