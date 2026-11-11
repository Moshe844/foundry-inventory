ALTER TABLE accounting_bank_accounts
  ADD COLUMN receipt_verified_ledger_id text REFERENCES accounting_accounts(id),
  ADD COLUMN receipt_verified_by text REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN receipt_verified_at timestamptz;

CREATE TABLE stockchief_runtime.bank_statement_originals (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bank_account_id text NOT NULL REFERENCES accounting_bank_accounts(id) ON DELETE CASCADE,
  filename text NOT NULL,
  source_hash text NOT NULL,
  original bytea NOT NULL,
  date_format text NOT NULL CHECK (date_format IN ('ISO','MDY','DMY')),
  row_count integer NOT NULL CHECK (row_count>0),
  imported_count integer NOT NULL CHECK (imported_count>=0 AND imported_count<=row_count),
  uploaded_by text REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,source_hash)
);
CREATE INDEX bank_statement_originals_account ON stockchief_runtime.bank_statement_originals(bank_account_id);

ALTER TABLE accounting_bank_transactions
  ADD COLUMN statement_id text REFERENCES stockchief_runtime.bank_statement_originals(id) ON DELETE SET NULL,
  ADD COLUMN statement_row integer CHECK (statement_row>0),
  ADD COLUMN remittance jsonb CHECK (remittance IS NULL OR jsonb_typeof(remittance)='array'),
  ADD COLUMN remittance_problem text,
  ADD COLUMN receipt_checked_at timestamptz,
  ADD COLUMN receipt_check_problem text;
CREATE TABLE stockchief_runtime.bank_remittance_originals (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bank_transaction_id text NOT NULL REFERENCES accounting_bank_transactions(id) ON DELETE CASCADE,
  filename text NOT NULL,
  source_hash text NOT NULL,
  original bytea NOT NULL,
  remittance jsonb NOT NULL CHECK (jsonb_typeof(remittance)='array'),
  confirmed_by text REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,bank_transaction_id,source_hash)
);
CREATE INDEX bank_remittance_originals_transaction ON stockchief_runtime.bank_remittance_originals(bank_transaction_id);
ALTER TABLE accounting_bank_transactions ADD COLUMN remittance_original_id text
  REFERENCES stockchief_runtime.bank_remittance_originals(id) ON DELETE SET NULL;
CREATE INDEX bank_remittance_transaction_source ON accounting_bank_transactions(remittance_original_id);
CREATE INDEX bank_statement_transaction_source ON accounting_bank_transactions(statement_id);
CREATE INDEX bank_statement_overlap ON accounting_bank_transactions(workspace_id,bank_account_id,transaction_date,amount_minor,md5(description));
CREATE INDEX bank_remittance_candidates ON accounting_bank_transactions(workspace_id,transaction_date,id)
  WHERE status='UNMATCHED' AND amount_minor>0 AND remittance IS NOT NULL;
CREATE INDEX bank_statement_payment_match ON accounting_bank_transactions(workspace_id,matched_payment_id)
  WHERE matched_payment_id IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.bank_statement_originals'::regclass,'octet_length(original)+octet_length(convert_to((to_jsonb(t)-''original'')::text,''UTF8''))'),
 ('stockchief_runtime.bank_remittance_originals'::regclass,'octet_length(original)+octet_length(convert_to((to_jsonb(t)-''original'')::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.bank_statement_originals'::regclass,'stockchief_runtime.bank_remittance_originals'::regclass);
