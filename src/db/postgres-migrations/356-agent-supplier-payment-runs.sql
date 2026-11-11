CREATE TABLE stockchief_runtime.agent_supplier_payment_checks (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  checked_on date NOT NULL,
  check_modes smallint NOT NULL CHECK (check_modes BETWEEN 1 AND 3),
  run_digest text,
  bill_count integer NOT NULL CHECK (bill_count >= 0),
  discount_count integer NOT NULL CHECK (discount_count >= 0)
);

CREATE TABLE stockchief_runtime.agent_supplier_payment_approvals (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  digest text NOT NULL,
  approved_by text REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, week_start, digest)
);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_supplier_payment_checks'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_supplier_payment_approvals'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN (VALUES
    ('stockchief_runtime.agent_supplier_payment_checks'::regclass),
    ('stockchief_runtime.agent_supplier_payment_approvals'::regclass)) r(relation);
