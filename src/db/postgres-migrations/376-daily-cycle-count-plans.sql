CREATE TABLE stockchief_runtime.daily_cycle_count_rules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  warehouse_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  maximum_shelves integer NOT NULL CHECK(maximum_shelves BETWEEN 1 AND 100),
  authorized_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,warehouse_id)
);

CREATE TABLE stockchief_runtime.daily_cycle_count_plans (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  warehouse_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  business_day date NOT NULL,
  status text NOT NULL CHECK(status IN('DRAFT','READY')),
  source_fingerprint text NOT NULL,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot->'shelves')='array'
    AND jsonb_array_length(snapshot->'shelves') BETWEEN 1 AND 100),
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  automatic boolean NOT NULL DEFAULT false,
  rule_revision integer,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at timestamptz,
  UNIQUE(workspace_id,warehouse_id,business_day),
  CHECK((status='READY')=(confirmed_at IS NOT NULL)),
  CHECK(NOT automatic OR status='READY' AND rule_revision IS NOT NULL)
);
CREATE INDEX daily_cycle_count_history ON stockchief_runtime.daily_cycle_count_plans(workspace_id,business_day DESC,warehouse_id);

INSERT INTO commercial_storage_tables(relation,bytes_expression)
SELECT relation_name::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'
FROM unnest(ARRAY['stockchief_runtime.daily_cycle_count_rules','stockchief_runtime.daily_cycle_count_plans']) registered(relation_name);
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
SELECT w.id,registered.relation_name::regclass,true FROM workspaces w CROSS JOIN
unnest(ARRAY['stockchief_runtime.daily_cycle_count_rules','stockchief_runtime.daily_cycle_count_plans']) registered(relation_name);
