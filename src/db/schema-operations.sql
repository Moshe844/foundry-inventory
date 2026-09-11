-- Mission 8: mature counts, returns and high-volume fulfillment.
-- These tables coordinate work and evidence. Physical truth remains in the
-- canonical movements/balances ledger; financial truth remains in accounting.

CREATE TABLE IF NOT EXISTS inventory_count_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  count_kind TEXT NOT NULL CHECK (count_kind IN ('CYCLE','FULL')),
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  frequency_days INTEGER CHECK (frequency_days IS NULL OR frequency_days > 0),
  next_due_date TEXT,
  blind_count INTEGER NOT NULL DEFAULT 1 CHECK (blind_count IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_count_plans_due
  ON inventory_count_plans(workspace_id, active, next_due_date);

CREATE TABLE IF NOT EXISTS inventory_count_plan_skus (
  plan_id TEXT NOT NULL REFERENCES inventory_count_plans(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  PRIMARY KEY(plan_id, sku_id)
);

CREATE TABLE IF NOT EXISTS inventory_count_campaigns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES inventory_count_plans(id) ON DELETE SET NULL,
  campaign_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  count_kind TEXT NOT NULL CHECK (count_kind IN ('CYCLE','FULL')),
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','RECOUNT_REQUIRED','AWAITING_APPROVAL','COMPLETED','CANCELLED')),
  blind_count INTEGER NOT NULL DEFAULT 1 CHECK (blind_count IN (0,1)),
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(workspace_id, campaign_number)
);
CREATE INDEX IF NOT EXISTS idx_count_campaigns_queue
  ON inventory_count_campaigns(workspace_id, status, created_at);

CREATE TABLE IF NOT EXISTS inventory_count_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES inventory_count_campaigns(id) ON DELETE CASCADE,
  parent_session_id TEXT REFERENCES inventory_count_sessions(id) ON DELETE SET NULL,
  pass_number INTEGER NOT NULL DEFAULT 1 CHECK (pass_number > 0),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','RECOUNT_REQUIRED','AWAITING_APPROVAL','COMPLETED','CANCELLED')),
  counted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  submitted_at TEXT,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_count_sessions_campaign
  ON inventory_count_sessions(campaign_id, pass_number);

CREATE TABLE IF NOT EXISTS inventory_count_lines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES inventory_count_sessions(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  lot_id TEXT REFERENCES lots(id) ON DELETE RESTRICT,
  expected_quantity INTEGER NOT NULL CHECK (expected_quantity >= 0),
  counted_quantity INTEGER CHECK (counted_quantity IS NULL OR counted_quantity >= 0),
  variance INTEGER,
  adjustment_movement_id TEXT REFERENCES movements(id) ON DELETE RESTRICT,
  note TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, sku_id, location_id, lot_id)
);
CREATE INDEX IF NOT EXISTS idx_count_lines_session ON inventory_count_lines(session_id);

CREATE TABLE IF NOT EXISTS customer_returns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  return_number TEXT NOT NULL,
  sales_order_id TEXT NOT NULL REFERENCES sales_orders(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED','AUTHORIZED','PARTIALLY_RECEIVED','RECEIVED','INSPECTED','AWAITING_REFUND','COMPLETED','CANCELLED')),
  resolution TEXT NOT NULL CHECK (resolution IN ('REFUND','EXCHANGE','NO_REFUND')),
  reason TEXT,
  quarantine_location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  refund_id TEXT REFERENCES accounting_sale_refunds(id) ON DELETE SET NULL,
  exchange_order_id TEXT REFERENCES sales_orders(id) ON DELETE SET NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  authorized_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  inspected_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  authorized_at TEXT,
  received_at TEXT,
  inspected_at TEXT,
  completed_at TEXT,
  UNIQUE(workspace_id, return_number)
);
CREATE INDEX IF NOT EXISTS idx_customer_returns_queue
  ON customer_returns(workspace_id, status, created_at);

CREATE TABLE IF NOT EXISTS customer_return_lines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_return_id TEXT NOT NULL REFERENCES customer_returns(id) ON DELETE CASCADE,
  sales_order_line_id TEXT NOT NULL REFERENCES sales_order_lines(id) ON DELETE RESTRICT,
  sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  quantity_authorized INTEGER NOT NULL CHECK (quantity_authorized > 0),
  quantity_received INTEGER NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  quantity_restocked INTEGER NOT NULL DEFAULT 0 CHECK (quantity_restocked >= 0),
  quantity_scrapped INTEGER NOT NULL DEFAULT 0 CHECK (quantity_scrapped >= 0),
  quantity_repair INTEGER NOT NULL DEFAULT 0 CHECK (quantity_repair >= 0),
  receive_movement_ids TEXT NOT NULL DEFAULT '[]',
  disposition_movement_ids TEXT NOT NULL DEFAULT '[]',
  tracking_evidence TEXT NOT NULL DEFAULT '{}',
  condition_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(customer_return_id, sales_order_line_id)
);

CREATE TABLE IF NOT EXISTS supplier_returns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  return_number TEXT NOT NULL,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  supplier_bill_id TEXT REFERENCES accounting_supplier_bills(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED','AUTHORIZED','SHIPPED','AWAITING_CREDIT','CREDIT_MISMATCH','RECONCILED','CANCELLED')),
  expected_credit_minor INTEGER CHECK (expected_credit_minor IS NULL OR expected_credit_minor >= 0),
  actual_credit_minor INTEGER CHECK (actual_credit_minor IS NULL OR actual_credit_minor >= 0),
  supplier_credit_id TEXT REFERENCES accounting_supplier_credits(id) ON DELETE SET NULL,
  reason TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  authorized_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  authorized_at TEXT,
  shipped_at TEXT,
  reconciled_at TEXT,
  UNIQUE(workspace_id, return_number)
);
CREATE INDEX IF NOT EXISTS idx_supplier_returns_queue
  ON supplier_returns(workspace_id, status, created_at);

CREATE TABLE IF NOT EXISTS supplier_return_lines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_return_id TEXT NOT NULL REFERENCES supplier_returns(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  lot_id TEXT REFERENCES lots(id) ON DELETE RESTRICT,
  serial_unit_ids TEXT NOT NULL DEFAULT '[]',
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  movement_ids TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fulfillment_waves (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wave_number INTEGER NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('WAVE','BATCH','CLUSTER')),
  status TEXT NOT NULL DEFAULT 'RELEASED'
    CHECK (status IN ('RELEASED','PICKING','PACKED','COMPLETED','BLOCKED','CANCELLED')),
  title TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(workspace_id, wave_number)
);
CREATE INDEX IF NOT EXISTS idx_fulfillment_waves_queue
  ON fulfillment_waves(workspace_id, status, created_at);

CREATE TABLE IF NOT EXISTS fulfillment_wave_shipments (
  wave_id TEXT NOT NULL REFERENCES fulfillment_waves(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sales_order_id TEXT NOT NULL REFERENCES sales_orders(id) ON DELETE RESTRICT,
  shipment_id TEXT NOT NULL REFERENCES sales_shipments(id) ON DELETE RESTRICT,
  container_id TEXT REFERENCES warehouse_containers(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'PICKING' CHECK (status IN ('PICKING','PACKED','SHIPPED','CANCELLED')),
  PRIMARY KEY(wave_id, shipment_id)
);

CREATE TABLE IF NOT EXISTS fulfillment_wave_lines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wave_id TEXT NOT NULL REFERENCES fulfillment_waves(id) ON DELETE CASCADE,
  shipment_id TEXT NOT NULL REFERENCES sales_shipments(id) ON DELETE RESTRICT,
  shipment_line_id TEXT NOT NULL REFERENCES sales_shipment_lines(id) ON DELETE RESTRICT,
  sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  planned_quantity INTEGER NOT NULL CHECK (planned_quantity > 0),
  picked_quantity INTEGER NOT NULL DEFAULT 0 CHECK (picked_quantity >= 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PICKED','SHORT')),
  UNIQUE(wave_id, shipment_line_id)
);

CREATE TABLE IF NOT EXISTS fulfillment_wave_scans (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wave_id TEXT NOT NULL REFERENCES fulfillment_waves(id) ON DELETE CASCADE,
  line_id TEXT REFERENCES fulfillment_wave_lines(id) ON DELETE SET NULL,
  client_scan_id TEXT NOT NULL,
  location_barcode TEXT,
  item_barcode TEXT,
  lot_id TEXT REFERENCES lots(id) ON DELETE RESTRICT,
  serial_unit_id TEXT REFERENCES serial_units(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL CHECK (status IN ('ACCEPTED','REJECTED')),
  message TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  scanned_at TEXT NOT NULL,
  UNIQUE(workspace_id, client_scan_id)
);
CREATE TRIGGER IF NOT EXISTS fulfillment_wave_scans_no_update
BEFORE UPDATE ON fulfillment_wave_scans BEGIN
  SELECT RAISE(ABORT, 'fulfillment wave scans are immutable');
END;
CREATE TRIGGER IF NOT EXISTS fulfillment_wave_scans_no_delete
BEFORE DELETE ON fulfillment_wave_scans BEGIN
  SELECT RAISE(ABORT, 'fulfillment wave scans are immutable');
END;
