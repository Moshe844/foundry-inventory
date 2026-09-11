-- Mission 7: the unit a supplier sells is not assumed to be the unit a
-- business stocks or sells.  Ratios are stored as integers, never floats, so
-- a conversion remains exact and cannot quietly change historic quantities.

CREATE TABLE IF NOT EXISTS uom_families (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, name COLLATE NOCASE)
);

CREATE TABLE IF NOT EXISTS units_of_measure (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL REFERENCES uom_families(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  -- Number of this unit represented by one family base unit.  The base unit is
  -- 1/1; a case of 12 each is 12/1.  Fractions are supported explicitly.
  base_numerator INTEGER NOT NULL CHECK (base_numerator > 0),
  base_denominator INTEGER NOT NULL CHECK (base_denominator > 0),
  created_at TEXT NOT NULL,
  UNIQUE (family_id, name COLLATE NOCASE),
  UNIQUE (family_id, symbol COLLATE NOCASE)
);

CREATE TABLE IF NOT EXISTS sku_uom_profiles (
  sku_id TEXT PRIMARY KEY REFERENCES skus(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL REFERENCES uom_families(id) ON DELETE RESTRICT,
  stocking_uom_id TEXT NOT NULL REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  selling_uom_id TEXT NOT NULL REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  -- Required only for allocation by weight.  Null means Foundry must ask; it
  -- may not estimate a carton, product, or variant weight.
  unit_weight_grams INTEGER CHECK (unit_weight_grams > 0),
  source TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner','import','supplier_document','connector')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_item_uom_mappings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_item_id TEXT NOT NULL REFERENCES supplier_items(id) ON DELETE CASCADE,
  purchase_uom_id TEXT NOT NULL REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  stocking_uom_id TEXT NOT NULL REFERENCES units_of_measure(id) ON DELETE RESTRICT,
  -- purchase quantity × numerator / denominator = stocking quantity.
  stocking_numerator INTEGER NOT NULL CHECK (stocking_numerator > 0),
  stocking_denominator INTEGER NOT NULL CHECK (stocking_denominator > 0),
  source TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner','import','supplier_document','connector')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (supplier_item_id, purchase_uom_id)
);

-- A landed-cost document records the charge and the evidence that made it
-- eligible for capitalization.  It does not modify a supplier bill or a
-- receipt; application creates an immutable accounting reclassification.
CREATE TABLE IF NOT EXISTS landed_cost_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_number TEXT NOT NULL,
  purchase_order_id TEXT REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  allocation_method TEXT NOT NULL CHECK (allocation_method IN ('quantity','value','weight','manual')),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','APPROVED','APPLIED','VOID','REVERSED')),
  currency TEXT NOT NULL DEFAULT 'USD',
  note TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TEXT,
  applied_at TEXT,
  reversed_at TEXT,
  reversal_of_document_id TEXT REFERENCES landed_cost_documents(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, document_number)
);

CREATE TABLE IF NOT EXISTS landed_cost_document_receipts (
  document_id TEXT NOT NULL REFERENCES landed_cost_documents(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL REFERENCES purchase_order_receipts(id) ON DELETE RESTRICT,
  PRIMARY KEY (document_id, receipt_id)
);

CREATE TABLE IF NOT EXISTS landed_cost_charges (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES landed_cost_documents(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('freight','duty','insurance','handling','other')),
  description TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  -- A posted non-inventory supplier-bill line is the accounting evidence.
  -- We reclassify its debit, rather than creating another payable.
  source_bill_line_id TEXT NOT NULL REFERENCES accounting_supplier_bill_lines(id) ON DELETE RESTRICT,
  source_evidence TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_landed_cost_charges_document ON landed_cost_charges(document_id);

CREATE TABLE IF NOT EXISTS landed_cost_allocations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES landed_cost_documents(id) ON DELETE RESTRICT,
  charge_id TEXT NOT NULL REFERENCES landed_cost_charges(id) ON DELETE RESTRICT,
  receipt_line_id TEXT NOT NULL REFERENCES purchase_order_receipt_lines(id) ON DELETE RESTRICT,
  sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  basis_value INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  accounting_journal_entry_id TEXT REFERENCES accounting_journal_entries(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (charge_id, receipt_line_id)
);
CREATE INDEX IF NOT EXISTS idx_landed_cost_allocations_document ON landed_cost_allocations(document_id, charge_id);
