CREATE TABLE stockchief_runtime.agent_open_to_buy_rules (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  revision text NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE stockchief_runtime.agent_open_to_buy_fences (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1
);

CREATE TABLE stockchief_runtime.agent_open_to_buy_plans (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  month_start date NOT NULL CHECK(extract(day from month_start)=1),
  evidence_hash text NOT NULL,
  snapshot jsonb NOT NULL,
  automatic boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'READY' CHECK(status IN('READY','DRAFTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  drafted_by text REFERENCES users(id) ON DELETE SET NULL,
  drafted_at timestamptz,
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,month_start,evidence_hash)
);
CREATE INDEX agent_open_to_buy_plans_recent ON stockchief_runtime.agent_open_to_buy_plans(workspace_id,month_start,created_at DESC,id);

CREATE TABLE stockchief_runtime.agent_open_to_buy_drafts (
  workspace_id text NOT NULL,
  plan_id text NOT NULL,
  purchase_order_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  month_start date NOT NULL,
  group_number integer NOT NULL CHECK(group_number>=0),
  order_fingerprint text NOT NULL,
  PRIMARY KEY(workspace_id,purchase_order_id),
  UNIQUE(workspace_id,plan_id,group_number),
  FOREIGN KEY(workspace_id,plan_id) REFERENCES stockchief_runtime.agent_open_to_buy_plans(workspace_id,id) ON DELETE CASCADE
);

INSERT INTO commercial_storage_tables(relation,bytes_expression)
 SELECT r::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'
 FROM unnest(ARRAY['stockchief_runtime.agent_open_to_buy_rules','stockchief_runtime.agent_open_to_buy_plans','stockchief_runtime.agent_open_to_buy_drafts']) r;
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,r::regclass,true FROM workspaces w
 CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_open_to_buy_rules','stockchief_runtime.agent_open_to_buy_plans','stockchief_runtime.agent_open_to_buy_drafts']) r;
