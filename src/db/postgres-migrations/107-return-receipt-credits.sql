-- Existing approved returns retain their original recognition policy.
ALTER TABLE customer_returns ADD COLUMN receipt_credit_policy TEXT
 CHECK(receipt_credit_policy IS NULL OR receipt_credit_policy='RECEIPT_CREDIT_V1');
CREATE TABLE accounting_return_receipt_credits (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 customer_return_id TEXT NOT NULL REFERENCES customer_returns(id),
 return_movement_id TEXT NOT NULL REFERENCES movements(id),
 original_journal_entry_id TEXT NOT NULL REFERENCES accounting_journal_entries(id),
 journal_entry_id TEXT NOT NULL REFERENCES accounting_journal_entries(id),
 revenue_minor BIGINT NOT NULL CHECK(revenue_minor>=0),
 tax_minor BIGINT NOT NULL CHECK(tax_minor>=0),
 cogs_minor BIGINT NOT NULL CHECK(cogs_minor>=0),
 ar_credit_minor BIGINT NOT NULL CHECK(ar_credit_minor>=0),
 cash_due_minor BIGINT NOT NULL CHECK(cash_due_minor>=0),
 cash_refunded_minor BIGINT NOT NULL DEFAULT 0 CHECK(cash_refunded_minor>=0 AND cash_refunded_minor<=cash_due_minor),
 source_key TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(ar_credit_minor+cash_due_minor=revenue_minor+tax_minor),
 UNIQUE(workspace_id,source_key)
);
CREATE INDEX return_receipt_credits_scope ON accounting_return_receipt_credits(workspace_id,customer_return_id);
ALTER TABLE accounting_sale_refunds ADD COLUMN recognition_stage TEXT NOT NULL DEFAULT 'ON_REFUND'
 CHECK(recognition_stage IN ('ON_REFUND','ON_RECEIPT'));
ALTER TABLE accounting_sale_refunds ADD COLUMN payment_journal_entry_id TEXT REFERENCES accounting_journal_entries(id);
ALTER TABLE accounting_sale_refunds ADD COLUMN settled_amount_minor BIGINT CHECK(settled_amount_minor>=0);
CREATE TABLE accounting_return_credit_conversions (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 customer_return_id TEXT NOT NULL REFERENCES customer_returns(id),
 review_hash TEXT NOT NULL,
 result JSONB NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,customer_return_id)
);
