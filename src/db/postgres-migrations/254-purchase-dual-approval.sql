CREATE TABLE stockchief_runtime.purchase_approval_thresholds (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  currency text NOT NULL,
  amount_minor bigint CHECK(amount_minor>=0),
  revision integer NOT NULL CHECK(revision>0),
  escalation_hours integer NOT NULL DEFAULT 24 CHECK(escalation_hours BETWEEN 1 AND 720),
  changed_by text NOT NULL REFERENCES users(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE stockchief_runtime.purchase_approval_signatures (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  purchase_order_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  digest text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>=0),
  account_id text NOT NULL REFERENCES accounts(id),
  actor_id text NOT NULL REFERENCES users(id),
  signed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,purchase_order_id,digest,account_id)
);
INSERT INTO commercial_storage_tables(relation,bytes_expression)
SELECT name::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'
FROM unnest(ARRAY['stockchief_runtime.purchase_approval_thresholds','stockchief_runtime.purchase_approval_signatures']) name;
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
SELECT w.id,registered.relation_name::regclass,true FROM workspaces w CROSS JOIN
unnest(ARRAY['stockchief_runtime.purchase_approval_thresholds','stockchief_runtime.purchase_approval_signatures']) registered(relation_name);
