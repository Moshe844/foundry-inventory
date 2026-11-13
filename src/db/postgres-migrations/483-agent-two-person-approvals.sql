-- Job 205: two people approve anything over the owner's amount. Purchase
-- orders keep purchase_approval_signatures. This holds the approvals of
-- refunds and credits, stock adjustments and write-offs and landed-cost
-- postings. digest binds each approval to the exact change and threshold, so
-- a changed amount needs fresh approvals; one row per account means the same
-- person approving twice counts once.
CREATE TABLE stockchief_runtime.agent_approval_signatures (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_key text NOT NULL,
  digest text NOT NULL,
  account_id text NOT NULL REFERENCES accounts(id),
  actor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_minor bigint CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  signed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,request_key,digest,account_id)
);
CREATE INDEX agent_approval_signatures_account ON stockchief_runtime.agent_approval_signatures(account_id);
CREATE INDEX agent_approval_signatures_person ON stockchief_runtime.agent_approval_signatures(actor_id);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_approval_signatures'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation='stockchief_runtime.agent_approval_signatures'::regclass;
