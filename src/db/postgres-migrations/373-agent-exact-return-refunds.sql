CREATE TABLE stockchief_runtime.agent_return_refund_plans (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_return_id text NOT NULL UNIQUE REFERENCES customer_returns(id) ON DELETE CASCADE,
  invoice_id text NOT NULL REFERENCES accounting_customer_invoices(id) ON DELETE CASCADE,
  currency text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  approved_by text REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  approval_key text NOT NULL,
  source_fingerprint text NOT NULL,
  snapshot jsonb NOT NULL,
  completed_at timestamptz,
  result jsonb,
  UNIQUE(workspace_id,approval_key)
);
CREATE INDEX agent_return_refund_plans_workspace ON stockchief_runtime.agent_return_refund_plans(workspace_id,approved_at);

CREATE TABLE stockchief_runtime.agent_return_refund_parts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES stockchief_runtime.agent_return_refund_plans(id) ON DELETE CASCADE,
  original_payment_id text NOT NULL REFERENCES accounting_payments(id) ON DELETE RESTRICT,
  cash_account_id text NOT NULL REFERENCES accounting_accounts(id),
  method text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  provider text,
  provider_account_id text,
  payment_request_id text REFERENCES payment_requests(id) ON DELETE RESTRICT,
  external_payment_id text,
  external_refund_id text,
  status text NOT NULL DEFAULT 'APPROVED' CHECK(status IN('APPROVED','SETTLED','FAILED','REVIEW')),
  journal_entry_id text REFERENCES accounting_journal_entries(id),
  settled_at timestamptz,
  UNIQUE(plan_id,original_payment_id),
  UNIQUE(workspace_id,provider,external_refund_id),
  CHECK (provider IS NULL AND provider_account_id IS NULL AND payment_request_id IS NULL AND external_payment_id IS NULL
      OR provider IS NOT NULL AND provider_account_id IS NOT NULL AND payment_request_id IS NOT NULL AND external_payment_id IS NOT NULL)
);
CREATE INDEX agent_return_refund_parts_payment ON stockchief_runtime.agent_return_refund_parts(workspace_id,original_payment_id,status);
CREATE INDEX agent_return_refund_parts_provider ON stockchief_runtime.agent_return_refund_parts(workspace_id,provider,external_payment_id)
 WHERE provider IS NOT NULL;

ALTER TABLE payment_refund_requests ADD COLUMN agent_part_id text UNIQUE
  REFERENCES stockchief_runtime.agent_return_refund_parts(id) ON DELETE CASCADE;
ALTER TABLE payment_refund_requests DROP CONSTRAINT payment_refund_requests_workspace_id_customer_return_id_key;
CREATE UNIQUE INDEX payment_refund_requests_legacy_return ON payment_refund_requests(workspace_id,customer_return_id)
 WHERE agent_part_id IS NULL;
CREATE INDEX payment_refund_requests_return ON payment_refund_requests(workspace_id,customer_return_id);
CREATE INDEX payment_refund_requests_original ON payment_refund_requests(workspace_id,provider,external_payment_id)
 WHERE status='SUCCEEDED';
CREATE INDEX payment_provider_events_refund_charge ON payment_provider_events(workspace_id,provider,(payload::jsonb#>>'{data,object,id}'))
 WHERE event_type='REFUNDED';

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_return_refund_plans'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_return_refund_parts'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_return_refund_plans'::regclass,'stockchief_runtime.agent_return_refund_parts'::regclass);
