-- Job 198: shadow mode. For an account's first 14 days StockChief only
-- watches. Each job that would have acted on its own records here what it
-- would have done, with its amounts and the evidence it used, so the
-- end-of-shadow report can show the orders it would have placed, the
-- stockouts it would have avoided and the money it would have caught.
-- One row per would-have action; a replay of the same action adds nothing.
CREATE TABLE stockchief_runtime.agent_shadow_actions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id int NOT NULL CHECK (job_id BETWEEN 1 AND 214),
  area text NOT NULL CHECK (area IN ('purchasing','counts','transfers','holds','orders','customers','catalog','other')),
  kind text NOT NULL CHECK (kind IN ('order','transfer','count','count_list','hold','message')),
  record_key text NOT NULL CHECK (length(record_key) BETWEEN 1 AND 300),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  sku_id text,
  location_id text,
  quantity numeric(24,6),
  amount_minor bigint,
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  lead_days int CHECK (lead_days IS NULL OR lead_days BETWEEN 0 AND 3650),
  caught_minor bigint CHECK (caught_minor IS NULL OR caught_minor>=0),
  evidence jsonb NOT NULL DEFAULT '{}',
  href text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id,job_id,record_key),
  CHECK (amount_minor IS NULL OR currency IS NOT NULL),
  CHECK (caught_minor IS NULL OR currency IS NOT NULL)
);
CREATE INDEX agent_shadow_actions_recent ON stockchief_runtime.agent_shadow_actions(workspace_id,recorded_at DESC,id);

-- The owner's choice when shadow mode ends: the areas StockChief may now
-- handle on its own, the inventory mode that followed and every job setting
-- the choice changed. One row per inventory.
CREATE TABLE stockchief_runtime.agent_shadow_decisions (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  areas text[] NOT NULL,
  mode text NOT NULL CHECK (mode IN ('OBSERVE','SUPERVISED','POLICY_AUTOMATED')),
  changes jsonb NOT NULL DEFAULT '{}',
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_shadow_actions'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation='stockchief_runtime.agent_shadow_actions'::regclass;
