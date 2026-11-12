-- Job 176: each approval goes to the right person by role and amount.
-- A routing rule is the owner's taught instruction "refunds over $500 go to
-- Sarah, not me": one kind of approval, an optional amount it must exceed, and
-- the person who gets it. It counts against the plan's saved-rule allowance.
CREATE TABLE stockchief_runtime.agent_approval_routes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('purchase','adjustment','refund','landed_cost','supplier_price','transfer','return')),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  above_minor bigint CHECK (above_minor BETWEEN 0 AND 9007199254740991),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((above_minor IS NULL)=(currency IS NULL))
);
CREATE UNIQUE INDEX agent_approval_routes_scope ON stockchief_runtime.agent_approval_routes(workspace_id,kind,coalesce(currency,''),coalesce(above_minor,-1)) WHERE enabled;
CREATE INDEX agent_approval_routes_workspace ON stockchief_runtime.agent_approval_routes(workspace_id,kind) WHERE enabled;
CREATE INDEX agent_approval_routes_person ON stockchief_runtime.agent_approval_routes(user_id);
CREATE INDEX agent_approval_routes_creator ON stockchief_runtime.agent_approval_routes(created_by) WHERE created_by IS NOT NULL;

-- A person's amount authority for one kind of money approval. Purchases keep
-- the limit on the Team page. No row means no amount limit for that kind,
-- the same as an empty purchase limit. A downgrade never removes a limit.
CREATE TABLE stockchief_runtime.agent_approval_limits (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('adjustment','refund','landed_cost')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  limit_minor bigint NOT NULL CHECK (limit_minor BETWEEN 0 AND 9007199254740991),
  changed_by text REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,user_id,kind)
);
CREATE INDEX agent_approval_limits_person ON stockchief_runtime.agent_approval_limits(user_id);
CREATE INDEX agent_approval_limits_changer ON stockchief_runtime.agent_approval_limits(changed_by) WHERE changed_by IS NOT NULL;

-- Where StockChief sent each waiting approval and why. One row per approval;
-- a new person or reason replaces it and is written to the security audit.
CREATE TABLE stockchief_runtime.agent_approval_assignments (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_key text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,request_key)
);
CREATE INDEX agent_approval_assignments_person ON stockchief_runtime.agent_approval_assignments(user_id);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_approval_routes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_approval_limits'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_approval_assignments'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation IN ('stockchief_runtime.agent_approval_routes'::regclass,'stockchief_runtime.agent_approval_limits'::regclass,
    'stockchief_runtime.agent_approval_assignments'::regclass);
