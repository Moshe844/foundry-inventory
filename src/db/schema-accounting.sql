-- Mission 14: deterministic accounting truth.
-- Money is stored in integer minor units. Operational records remain the
-- physical truth; journal entries are immutable financial consequences.

CREATE TABLE IF NOT EXISTS accounting_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  accounting_start_date TEXT,
  base_currency TEXT NOT NULL DEFAULT 'USD',
  costing_method TEXT NOT NULL DEFAULT 'WEIGHTED_AVERAGE'
    CHECK (costing_method IN ('WEIGHTED_AVERAGE', 'FIFO', 'SPECIFIC_IDENTIFICATION')),
  configured_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  configured_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounting_accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL
    CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COGS', 'EXPENSE')),
  subtype TEXT,
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
  system_key TEXT,
  is_control INTEGER NOT NULL DEFAULT 0 CHECK (is_control IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, code),
  UNIQUE (workspace_id, system_key)
);

CREATE INDEX IF NOT EXISTS idx_accounting_accounts_workspace_type
  ON accounting_accounts(workspace_id, account_type, active);

CREATE TABLE IF NOT EXISTS accounting_tax_rates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  rate_millionths INTEGER NOT NULL CHECK (rate_millionths >= 0 AND rate_millionths <= 1000000),
  applies_to TEXT NOT NULL DEFAULT 'SALES' CHECK (applies_to IN ('SALES', 'PURCHASES', 'BOTH')),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (workspace_id, name, jurisdiction, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_accounting_tax_rates_active
  ON accounting_tax_rates(workspace_id, active, applies_to, effective_from);

CREATE TABLE IF NOT EXISTS accounting_periods (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  closed_by_user_id TEXT REFERENCES users(id),
  closed_at TEXT,
  close_note TEXT,
  created_at TEXT NOT NULL,
  CHECK (starts_on <= ends_on),
  UNIQUE (workspace_id, starts_on, ends_on)
);

CREATE INDEX IF NOT EXISTS idx_accounting_periods_workspace_dates
  ON accounting_periods(workspace_id, starts_on, ends_on);

CREATE TABLE IF NOT EXISTS accounting_journal_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entry_number INTEGER NOT NULL,
  posting_date TEXT NOT NULL,
  period_id TEXT NOT NULL REFERENCES accounting_periods(id),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED')),
  source_type TEXT NOT NULL,
  source_record_type TEXT,
  source_record_id TEXT,
  source_event_id TEXT,
  source_key TEXT NOT NULL,
  reversal_of_entry_id TEXT REFERENCES accounting_journal_entries(id),
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('SYSTEM', 'USER', 'CONNECTOR')),
  created_by_user_id TEXT REFERENCES users(id),
  approved_by_user_id TEXT REFERENCES users(id),
  engine_version TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  posted_at TEXT,
  UNIQUE (workspace_id, entry_number),
  UNIQUE (workspace_id, source_key),
  UNIQUE (workspace_id, reversal_of_entry_id)
);

CREATE INDEX IF NOT EXISTS idx_accounting_entries_workspace_date
  ON accounting_journal_entries(workspace_id, posting_date, entry_number);
CREATE INDEX IF NOT EXISTS idx_accounting_entries_source
  ON accounting_journal_entries(workspace_id, source_type, source_record_type, source_record_id);

CREATE TABLE IF NOT EXISTS accounting_journal_lines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES accounting_journal_entries(id) ON DELETE RESTRICT,
  line_number INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounting_accounts(id) ON DELETE RESTRICT,
  debit_minor INTEGER NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor INTEGER NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  currency TEXT NOT NULL,
  customer_id TEXT,
  supplier_id TEXT,
  item_id TEXT,
  sku_id TEXT,
  location_id TEXT,
  memo TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  CHECK ((debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0)),
  UNIQUE (entry_id, line_number)
);

CREATE INDEX IF NOT EXISTS idx_accounting_lines_account
  ON accounting_journal_lines(workspace_id, account_id, entry_id);
CREATE INDEX IF NOT EXISTS idx_accounting_lines_supplier
  ON accounting_journal_lines(workspace_id, supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounting_lines_customer
  ON accounting_journal_lines(workspace_id, customer_id) WHERE customer_id IS NOT NULL;

-- Posted entries and their lines are append-only. Corrections are new reversing
-- entries, never edits or deletes of history.
CREATE TRIGGER IF NOT EXISTS trg_accounting_posted_entry_no_update
BEFORE UPDATE ON accounting_journal_entries
WHEN OLD.status = 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'posted journal entries are immutable; create a reversal');
END;

CREATE TRIGGER IF NOT EXISTS trg_accounting_posted_entry_no_delete
BEFORE DELETE ON accounting_journal_entries
WHEN OLD.status = 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'posted journal entries cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_accounting_posted_line_no_update
BEFORE UPDATE ON accounting_journal_lines
WHEN EXISTS (SELECT 1 FROM accounting_journal_entries e
             WHERE e.id = OLD.entry_id AND e.status = 'POSTED')
BEGIN
  SELECT RAISE(ABORT, 'posted journal lines are immutable; create a reversal');
END;

CREATE TRIGGER IF NOT EXISTS trg_accounting_posted_line_no_delete
BEFORE DELETE ON accounting_journal_lines
WHEN EXISTS (SELECT 1 FROM accounting_journal_entries e
             WHERE e.id = OLD.entry_id AND e.status = 'POSTED')
BEGIN
  SELECT RAISE(ABORT, 'posted journal lines cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS accounting_event_inbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain_event_id TEXT NOT NULL REFERENCES domain_events(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'POSTED', 'IGNORED', 'NEEDS_REVIEW', 'FAILED')),
  journal_entry_id TEXT REFERENCES accounting_journal_entries(id),
  outcome TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE (workspace_id, domain_event_id)
);

CREATE INDEX IF NOT EXISTS idx_accounting_event_inbox_status
  ON accounting_event_inbox(workspace_id, status, created_at);

CREATE TABLE IF NOT EXISTS accounting_inventory_cost_balances (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  quantity_units INTEGER NOT NULL DEFAULT 0 CHECK (quantity_units >= 0),
  total_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_cost_minor >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, sku_id, location_id),
  CHECK (quantity_units > 0 OR total_cost_minor = 0)
);

CREATE TABLE IF NOT EXISTS accounting_inventory_cost_movements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  inventory_movement_id TEXT NOT NULL REFERENCES movements(id) ON DELETE RESTRICT,
  inventory_group_id TEXT NOT NULL,
  sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
  cost_delta_minor INTEGER NOT NULL,
  unit_cost_minor INTEGER,
  balance_quantity_units INTEGER NOT NULL CHECK (balance_quantity_units >= 0),
  balance_cost_minor INTEGER NOT NULL CHECK (balance_cost_minor >= 0),
  journal_entry_id TEXT REFERENCES accounting_journal_entries(id),
  cost_source_type TEXT NOT NULL,
  cost_source_record_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, inventory_movement_id)
);

CREATE INDEX IF NOT EXISTS idx_accounting_cost_movements_sku
  ON accounting_inventory_cost_movements(workspace_id, sku_id, created_at, id);

-- Cost-only corrections such as an evidenced supplier credit do not invent a
-- physical movement. Quantity stays unchanged while the exact value change is
-- preserved separately for audit and valuation drill-down.
CREATE TABLE IF NOT EXISTS accounting_inventory_value_adjustments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  amount_delta_minor INTEGER NOT NULL CHECK (amount_delta_minor <> 0),
  quantity_units INTEGER NOT NULL CHECK (quantity_units >= 0),
  source_type TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  journal_entry_id TEXT REFERENCES accounting_journal_entries(id),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, source_type, source_record_id, sku_id, location_id)
);

CREATE TRIGGER IF NOT EXISTS trg_accounting_cost_movement_no_update
BEFORE UPDATE ON accounting_inventory_cost_movements
BEGIN
  SELECT RAISE(ABORT, 'inventory cost history is immutable; create a correction');
END;

CREATE TRIGGER IF NOT EXISTS trg_accounting_cost_movement_no_delete
BEFORE DELETE ON accounting_inventory_cost_movements
BEGIN
  SELECT RAISE(ABORT, 'inventory cost history cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS accounting_sales_recognition (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sales_order_id TEXT NOT NULL REFERENCES sales_orders(id) ON DELETE RESTRICT,
  fulfilled_units INTEGER NOT NULL DEFAULT 0,
  gross_minor INTEGER NOT NULL DEFAULT 0,
  discount_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  net_receivable_minor INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, sales_order_id)
);

-- Refunds are independent financial evidence. A refund can reverse revenue
-- without claiming that merchandise physically returned; inventory/COGS are
-- reversed only when incoming inventory movements are supplied as evidence.
CREATE TABLE IF NOT EXISTS accounting_sale_refunds (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  original_journal_entry_id TEXT NOT NULL REFERENCES accounting_journal_entries(id) ON DELETE RESTRICT,
  refund_reference TEXT,
  refund_date TEXT NOT NULL,
  revenue_minor INTEGER NOT NULL CHECK (revenue_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  cogs_minor INTEGER NOT NULL DEFAULT 0 CHECK (cogs_minor >= 0),
  physical_return INTEGER NOT NULL DEFAULT 0 CHECK (physical_return IN (0, 1)),
  destination TEXT NOT NULL CHECK (destination IN ('AR', 'CASH')),
  journal_entry_id TEXT NOT NULL REFERENCES accounting_journal_entries(id) ON DELETE RESTRICT,
  source_key TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, source_key)
);

CREATE INDEX IF NOT EXISTS idx_accounting_sale_refunds_original
  ON accounting_sale_refunds(workspace_id, original_journal_entry_id, refund_date);

CREATE TABLE IF NOT EXISTS accounting_customer_invoices (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  sales_order_id TEXT REFERENCES sales_orders(id) ON DELETE RESTRICT,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'OPEN', 'PARTIALLY_PAID', 'PAID', 'VOID')),
  currency TEXT NOT NULL,
  subtotal_minor INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  balance_minor INTEGER NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  journal_entry_id TEXT REFERENCES accounting_journal_entries(id),
  source_key TEXT NOT NULL,
  notes TEXT,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  opened_at TEXT,
  paid_at TEXT,
  payment_status_confirmed_at TEXT,
  voided_at TEXT,
  UNIQUE (workspace_id, invoice_number),
  UNIQUE (workspace_id, source_key)
);

CREATE TABLE IF NOT EXISTS accounting_customer_invoice_lines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invoice_id TEXT NOT NULL REFERENCES accounting_customer_invoices(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
  revenue_account_id TEXT NOT NULL REFERENCES accounting_accounts(id),
  item_id TEXT,
  sku_id TEXT,
  sales_order_line_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (invoice_id, line_number)
);

CREATE INDEX IF NOT EXISTS idx_accounting_customer_invoices_due
  ON accounting_customer_invoices(workspace_id, status, due_date);

CREATE TABLE IF NOT EXISTS accounting_supplier_bills (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bill_number TEXT NOT NULL,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  purchase_order_id TEXT REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  purchase_receipt_id TEXT REFERENCES purchase_order_receipts(id) ON DELETE RESTRICT,
  supplier_invoice_number TEXT,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'OPEN', 'PARTIALLY_PAID', 'PAID', 'DISPUTED', 'VOID')),
  match_status TEXT NOT NULL DEFAULT 'NOT_MATCHED'
    CHECK (match_status IN ('NOT_MATCHED', 'MATCHED', 'WITHIN_TOLERANCE', 'EXCEPTION')),
  currency TEXT NOT NULL,
  subtotal_minor INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  balance_minor INTEGER NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  journal_entry_id TEXT REFERENCES accounting_journal_entries(id),
  evidence_message_id TEXT,
  evidence_document_id TEXT,
  source_key TEXT NOT NULL,
  exception_detail TEXT NOT NULL DEFAULT '{}',
  notes TEXT,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  opened_at TEXT,
  paid_at TEXT,
  voided_at TEXT,
  UNIQUE (workspace_id, bill_number),
  UNIQUE (workspace_id, source_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_supplier_invoice
  ON accounting_supplier_bills(workspace_id, supplier_id, supplier_invoice_number)
  WHERE supplier_invoice_number IS NOT NULL AND status <> 'VOID';
CREATE INDEX IF NOT EXISTS idx_accounting_supplier_bills_due
  ON accounting_supplier_bills(workspace_id, status, due_date);

CREATE TABLE IF NOT EXISTS accounting_supplier_bill_lines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bill_id TEXT NOT NULL REFERENCES accounting_supplier_bills(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
  debit_account_id TEXT NOT NULL REFERENCES accounting_accounts(id),
  item_id TEXT,
  sku_id TEXT,
  purchase_order_line_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (bill_id, line_number)
);

CREATE TABLE IF NOT EXISTS accounting_payments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  payment_number TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('CUSTOMER_RECEIPT', 'SUPPLIER_PAYMENT')),
  customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT,
  supplier_id TEXT REFERENCES suppliers(id) ON DELETE RESTRICT,
  payment_date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  method TEXT,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOID')),
  cash_account_id TEXT NOT NULL REFERENCES accounting_accounts(id),
  journal_entry_id TEXT NOT NULL REFERENCES accounting_journal_entries(id),
  source_key TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  voided_at TEXT,
  CHECK ((direction = 'CUSTOMER_RECEIPT' AND customer_id IS NOT NULL AND supplier_id IS NULL)
      OR (direction = 'SUPPLIER_PAYMENT' AND supplier_id IS NOT NULL AND customer_id IS NULL)),
  UNIQUE (workspace_id, payment_number),
  UNIQUE (workspace_id, source_key)
);

CREATE TABLE IF NOT EXISTS accounting_payment_allocations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  payment_id TEXT NOT NULL REFERENCES accounting_payments(id) ON DELETE RESTRICT,
  customer_invoice_id TEXT REFERENCES accounting_customer_invoices(id) ON DELETE RESTRICT,
  supplier_bill_id TEXT REFERENCES accounting_supplier_bills(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  created_at TEXT NOT NULL,
  CHECK ((customer_invoice_id IS NOT NULL AND supplier_bill_id IS NULL)
      OR (supplier_bill_id IS NOT NULL AND customer_invoice_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_accounting_payment_allocations_invoice
  ON accounting_payment_allocations(workspace_id, customer_invoice_id);
CREATE INDEX IF NOT EXISTS idx_accounting_payment_allocations_bill
  ON accounting_payment_allocations(workspace_id, supplier_bill_id);

CREATE TABLE IF NOT EXISTS accounting_supplier_credits (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_bill_id TEXT NOT NULL REFERENCES accounting_supplier_bills(id) ON DELETE RESTRICT,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  credit_number TEXT,
  credit_date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  reason TEXT,
  evidence_document_id TEXT,
  journal_entry_id TEXT NOT NULL REFERENCES accounting_journal_entries(id) ON DELETE RESTRICT,
  source_key TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_accounting_supplier_credits_bill
  ON accounting_supplier_credits(workspace_id, supplier_bill_id, credit_date);

CREATE TABLE IF NOT EXISTS accounting_bank_accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  account_kind TEXT NOT NULL CHECK (account_kind IN ('BANK', 'CREDIT_CARD')),
  currency TEXT NOT NULL,
  ledger_account_id TEXT NOT NULL REFERENCES accounting_accounts(id),
  institution_name TEXT,
  masked_identifier TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS accounting_bank_transactions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bank_account_id TEXT NOT NULL REFERENCES accounting_bank_accounts(id) ON DELETE CASCADE,
  external_id TEXT,
  transaction_date TEXT NOT NULL,
  posted_date TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  description TEXT NOT NULL,
  counterparty TEXT,
  reference TEXT,
  content_hash TEXT NOT NULL,
  import_source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNMATCHED'
    CHECK (status IN ('UNMATCHED', 'MATCHED', 'EXCLUDED', 'RECONCILED')),
  matched_journal_entry_id TEXT REFERENCES accounting_journal_entries(id),
  matched_payment_id TEXT REFERENCES accounting_payments(id),
  imported_at TEXT NOT NULL,
  matched_at TEXT,
  UNIQUE (workspace_id, bank_account_id, content_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_bank_external
  ON accounting_bank_transactions(workspace_id, bank_account_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounting_bank_transactions_status
  ON accounting_bank_transactions(workspace_id, bank_account_id, status, transaction_date);

CREATE TABLE IF NOT EXISTS accounting_reconciliations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bank_account_id TEXT NOT NULL REFERENCES accounting_bank_accounts(id) ON DELETE RESTRICT,
  statement_end_date TEXT NOT NULL,
  statement_ending_balance_minor INTEGER NOT NULL,
  ledger_ending_balance_minor INTEGER NOT NULL,
  difference_minor INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'VOID')),
  completed_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (workspace_id, bank_account_id, statement_end_date)
);

CREATE TABLE IF NOT EXISTS accounting_reconciliation_items (
  reconciliation_id TEXT NOT NULL REFERENCES accounting_reconciliations(id) ON DELETE CASCADE,
  bank_transaction_id TEXT NOT NULL REFERENCES accounting_bank_transactions(id) ON DELETE RESTRICT,
  PRIMARY KEY (reconciliation_id, bank_transaction_id)
);

CREATE TABLE IF NOT EXISTS accounting_opening_balance_sets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  accounting_start_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  costing_method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED')),
  integrity_hash TEXT NOT NULL,
  source_description TEXT,
  journal_entry_id TEXT REFERENCES accounting_journal_entries(id),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  approved_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  posted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_one_posted_opening
  ON accounting_opening_balance_sets(workspace_id) WHERE status = 'POSTED';

CREATE TABLE IF NOT EXISTS accounting_opening_balance_lines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  opening_set_id TEXT NOT NULL REFERENCES accounting_opening_balance_sets(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounting_accounts(id),
  debit_minor INTEGER NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor INTEGER NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  memo TEXT,
  CHECK ((debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0))
);

CREATE TABLE IF NOT EXISTS accounting_inventory_openings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  opening_set_id TEXT NOT NULL REFERENCES accounting_opening_balance_sets(id) ON DELETE RESTRICT,
  sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  quantity_units INTEGER NOT NULL CHECK (quantity_units >= 0),
  total_cost_minor INTEGER NOT NULL CHECK (total_cost_minor >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (opening_set_id, sku_id, location_id),
  CHECK (quantity_units > 0 OR total_cost_minor = 0)
);

-- Collecting money online (Mission 15)
--
-- A request is Foundry asking a customer to pay something, through somebody
-- else's payment surface. Foundry never sees a card number: it holds the
-- provider's identifiers and the hosted URL, and learns what happened from
-- events the provider sends back.
--
-- Deliberately provider-shaped only in the columns that have to be. Everything
-- above this table talks about a request, an amount and a link; which company
-- processed it is a detail, so that a second provider is a new row value rather
-- than a new concept.

CREATE TABLE IF NOT EXISTS payment_requests (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invoice_id           TEXT REFERENCES accounting_customer_invoices(id) ON DELETE CASCADE,
  sales_order_id       TEXT REFERENCES sales_orders(id) ON DELETE SET NULL,
  customer_id          TEXT REFERENCES customers(id) ON DELETE SET NULL,
  provider             TEXT NOT NULL,
  purpose              TEXT NOT NULL DEFAULT 'BALANCE'
                         CHECK (purpose IN ('DEPOSIT','BALANCE','FULL')),
  amount_minor         INTEGER NOT NULL CHECK (amount_minor > 0),
  currency             TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT','OPEN','PAID','VOID','FAILED')),
  external_customer_id TEXT,
  external_invoice_id  TEXT,
  hosted_url           TEXT,
  paid_minor           INTEGER NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  last_error           TEXT,
  created_by_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  opened_at            TEXT,
  paid_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_requests_invoice
  ON payment_requests(workspace_id, invoice_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_requests_external
  ON payment_requests(provider, external_invoice_id);

-- Every event a provider sent, kept before it is acted on.
--
-- The unique key is the provider's own event id, which is what makes a
-- redelivered webhook harmless: providers retry, and a payment recorded twice
-- is worse than one recorded late.
CREATE TABLE IF NOT EXISTS payment_provider_events (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  payload           TEXT NOT NULL,
  request_id        TEXT REFERENCES payment_requests(id) ON DELETE SET NULL,
  payment_id        TEXT REFERENCES accounting_payments(id) ON DELETE SET NULL,
  outcome           TEXT,
  received_at       TEXT NOT NULL,
  processed_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_provider_events
  ON payment_provider_events(workspace_id, provider, external_event_id);
