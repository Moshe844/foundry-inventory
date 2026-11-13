-- Job 183: per-channel stock buffers that keep N units or N% of the stock
-- back, and buffers StockChief sets itself from each channel's sales speed and
-- sync lag within the owner's rules.
--
-- A buffer (and its recipe, which counts as one saved rule) now holds either
-- whole units or a share of the stock, never both. set_by says whether the
-- owner or StockChief chose it, and basis keeps the facts StockChief used.
ALTER TABLE stockchief_runtime.agent_channel_buffer_recipes ADD COLUMN buffer_percent smallint NOT NULL DEFAULT 0;
ALTER TABLE stockchief_runtime.agent_channel_buffers ADD COLUMN buffer_percent smallint NOT NULL DEFAULT 0,
  ADD COLUMN set_by text NOT NULL DEFAULT 'OWNER' CHECK (set_by IN ('OWNER','AGENT')),
  ADD COLUMN basis jsonb;
DO $$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname,conrelid::regclass::text AS rel FROM pg_constraint
   WHERE conrelid IN ('stockchief_runtime.agent_channel_buffer_recipes'::regclass,'stockchief_runtime.agent_channel_buffers'::regclass)
     AND contype IN ('c','u') AND pg_get_constraintdef(oid) LIKE '%buffer_units%' LOOP
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.rel,c.conname);
 END LOOP;
END $$;
ALTER TABLE stockchief_runtime.agent_channel_buffer_recipes
  ADD CONSTRAINT agent_channel_buffer_recipe_amount CHECK (buffer_units BETWEEN 0 AND 100000 AND buffer_percent BETWEEN 0 AND 90 AND (buffer_units>0)<>(buffer_percent>0)),
  ADD CONSTRAINT agent_channel_buffer_recipe_identity UNIQUE (workspace_id,authorized_by,connector_id,location_id,buffer_units,buffer_percent,automatic_enabled);
ALTER TABLE stockchief_runtime.agent_channel_buffers
  ADD CONSTRAINT agent_channel_buffer_amount CHECK (buffer_units BETWEEN 0 AND 100000 AND buffer_percent BETWEEN 0 AND 90 AND (buffer_units>0)<>(buffer_percent>0));

-- The owner's rule for one channel: StockChief may set buffers of up to
-- max_units per product there. Growth drafts them for approval; with automatic
-- (Pro and Custom) StockChief sets them itself. Each enabled rule is one saved rule.
CREATE TABLE stockchief_runtime.agent_channel_buffer_rules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES workspace_connectors(id),
  max_units integer NOT NULL CHECK (max_units BETWEEN 1 AND 100000),
  automatic boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  authorized_by text NOT NULL REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,connector_id)
);
CREATE INDEX agent_channel_buffer_rule_connector ON stockchief_runtime.agent_channel_buffer_rules(connector_id);
CREATE INDEX agent_channel_buffer_rule_owner ON stockchief_runtime.agent_channel_buffer_rules(authorized_by);

-- Each buffer StockChief worked out for a product on a channel: a draft for the
-- owner, held (over the owner's limit or the rule allowance), applied (with the
-- buffer it replaced, for undo), dismissed, replaced by a newer one, or undone.
CREATE TABLE stockchief_runtime.agent_channel_buffer_plans (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position_id text NOT NULL REFERENCES connection_commerce_positions(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES workspace_connectors(id),
  units integer NOT NULL CHECK (units BETWEEN 1 AND 100000),
  basis jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT','HELD','APPLIED','DISMISSED','SUPERSEDED','UNDONE')),
  automatic boolean NOT NULL DEFAULT false,
  reason text,
  prior jsonb,
  buffer_id text,
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX agent_channel_buffer_plan_open ON stockchief_runtime.agent_channel_buffer_plans(workspace_id,position_id) WHERE status IN ('DRAFT','HELD');
CREATE INDEX agent_channel_buffer_plan_recent ON stockchief_runtime.agent_channel_buffer_plans(workspace_id,created_at DESC,id);
CREATE INDEX agent_channel_buffer_plan_position ON stockchief_runtime.agent_channel_buffer_plans(position_id);
CREATE INDEX agent_channel_buffer_plan_connector ON stockchief_runtime.agent_channel_buffer_plans(connector_id);
CREATE INDEX agent_channel_buffer_plan_person ON stockchief_runtime.agent_channel_buffer_plans(decided_by) WHERE decided_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_channel_buffer_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_channel_buffer_plans'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation IN ('stockchief_runtime.agent_channel_buffer_rules'::regclass,'stockchief_runtime.agent_channel_buffer_plans'::regclass);
