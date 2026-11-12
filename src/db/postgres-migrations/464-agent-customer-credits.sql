-- Job 107: refunds and credits a person approves for price adjustments,
-- overcharges (money paid beyond what an order came to) and orders cancelled
-- after payment. Returns keep their own refund plans.
CREATE TABLE stockchief_runtime.agent_customer_credits (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('price_adjustment','overpayment','cancellation')),
  customer_id text NOT NULL REFERENCES customers(id),
  invoice_id text REFERENCES accounting_customer_invoices(id),
  sales_order_id text REFERENCES sales_orders(id),
  currency text NOT NULL,
  credit_minor bigint NOT NULL CHECK (credit_minor>=0),
  ar_minor bigint NOT NULL CHECK (ar_minor>=0),
  refund_minor bigint NOT NULL CHECK (refund_minor>=0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  snapshot jsonb NOT NULL,
  source_fingerprint text NOT NULL,
  approval_key text NOT NULL,
  approved_by text NOT NULL REFERENCES users(id),
  journal_entry_id text REFERENCES accounting_journal_entries(id),
  status text NOT NULL CHECK (status IN ('AWAITING_REFUND','COMPLETED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,approval_key),
  CHECK (kind<>'price_adjustment' OR (invoice_id IS NOT NULL AND credit_minor=ar_minor+refund_minor AND credit_minor>0)),
  CHECK (kind='price_adjustment' OR (sales_order_id IS NOT NULL AND credit_minor=0 AND ar_minor=0 AND refund_minor>0)),
  CHECK ((status='COMPLETED')=(completed_at IS NOT NULL))
);
CREATE INDEX agent_customer_credit_customer ON stockchief_runtime.agent_customer_credits(customer_id);
CREATE INDEX agent_customer_credit_invoice ON stockchief_runtime.agent_customer_credits(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX agent_customer_credit_order ON stockchief_runtime.agent_customer_credits(sales_order_id) WHERE sales_order_id IS NOT NULL;
CREATE INDEX agent_customer_credit_approver ON stockchief_runtime.agent_customer_credits(approved_by);
CREATE INDEX agent_customer_credit_journal ON stockchief_runtime.agent_customer_credits(journal_entry_id) WHERE journal_entry_id IS NOT NULL;
CREATE INDEX agent_customer_credit_recent ON stockchief_runtime.agent_customer_credits(workspace_id,created_at DESC,id);

-- Each refund goes back through one original payment: through the payment
-- provider when it took the money, otherwise as an instruction for a person
-- to pay, which is booked only when they say it is paid.
CREATE TABLE stockchief_runtime.agent_customer_credit_refunds (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  credit_id text NOT NULL,
  original_payment_id text NOT NULL REFERENCES accounting_payments(id),
  cash_account_id text NOT NULL REFERENCES accounting_accounts(id),
  method text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  provider text CHECK (provider IS NULL OR provider IN ('stripe','cardknox')),
  provider_account_id text,
  payment_request_id text,
  external_payment_id text,
  status text NOT NULL CHECK (status IN ('TO_PAY','APPROVED','REVIEW','FAILED','SETTLED')),
  paid_reference text,
  paid_by text REFERENCES users(id),
  external_refund_id text,
  journal_entry_id text REFERENCES accounting_journal_entries(id),
  deposit_refund_id text REFERENCES accounting_deposit_refunds(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,credit_id) REFERENCES stockchief_runtime.agent_customer_credits(workspace_id,id) ON DELETE CASCADE,
  CHECK (provider IS NOT NULL OR (status IN ('TO_PAY','SETTLED') AND external_refund_id IS NULL)),
  CHECK (provider IS NULL OR status<>'TO_PAY'),
  CHECK ((status='SETTLED')=(journal_entry_id IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE INDEX agent_customer_credit_refund_credit ON stockchief_runtime.agent_customer_credit_refunds(workspace_id,credit_id);
CREATE INDEX agent_customer_credit_refund_payment ON stockchief_runtime.agent_customer_credit_refunds(original_payment_id);
CREATE INDEX agent_customer_credit_refund_cash ON stockchief_runtime.agent_customer_credit_refunds(cash_account_id);
CREATE INDEX agent_customer_credit_refund_paid_by ON stockchief_runtime.agent_customer_credit_refunds(paid_by) WHERE paid_by IS NOT NULL;
CREATE INDEX agent_customer_credit_refund_journal ON stockchief_runtime.agent_customer_credit_refunds(journal_entry_id) WHERE journal_entry_id IS NOT NULL;
CREATE INDEX agent_customer_credit_refund_deposit ON stockchief_runtime.agent_customer_credit_refunds(deposit_refund_id) WHERE deposit_refund_id IS NOT NULL;
CREATE INDEX agent_customer_credit_refund_open ON stockchief_runtime.agent_customer_credit_refunds(workspace_id,created_at) WHERE status IN ('TO_PAY','APPROVED','REVIEW','FAILED');

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_customer_credits'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_customer_credit_refunds'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY[
    'stockchief_runtime.agent_customer_credits'::regclass,
    'stockchief_runtime.agent_customer_credit_refunds'::regclass]) r;
