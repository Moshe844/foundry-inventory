-- Foundry Inventory : suppliers, purchasing and replenishment (Mission 6)
--
-- This is the first part of Foundry that reaches outside the warehouse. It
-- exists for one reason: an inventory manager cannot answer "what should I
-- buy?" without knowing who sells it, how it is packed, how long it takes to
-- arrive, and what is already on its way.
--
-- What it deliberately is not: accounting. There are no invoices, no payables,
-- no journal entries and no valuation here. A purchase order records an
-- intention to buy and what actually arrived. Money appears only as the cost a
-- supplier quoted, kept so that "this was $7.90 last time" is answerable.
--
-- Nothing in this file changes a balance. Receiving writes movements through
-- the Mission 1 engine and records the movement ids it produced; the stock
-- itself is still only ever moved by the engine.

-- A purchasing partner. Scoped to one workspace: two inventories that both buy
-- from "ABC Footwear" have two supplier records, because they are two separate
-- businesses' relationships with different terms.
CREATE TABLE IF NOT EXISTS suppliers (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  code                  TEXT,
  contact_name          TEXT,
  email                 TEXT,
  phone                 TEXT,
  notes                 TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),

  -- How long this supplier usually takes, in days. The per-item figure wins
  -- when there is one; this is the fallback and the starting point.
  default_lead_time_days INTEGER,
  minimum_order_amount   REAL,
  currency               TEXT NOT NULL DEFAULT 'USD',
  -- Informational only. Foundry does not calculate due dates or balances.
  payment_terms          TEXT,

  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_name ON suppliers(workspace_id, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_suppliers_workspace ON suppliers(workspace_id, status, name);

-- What one supplier calls one of our SKUs, and how they sell it.
--
-- The purchase unit is the point of this table. We count shoes; ABC Footwear
-- sells cases of twelve with a minimum of two cases. Every quantity Foundry
-- recommends has to survive that conversion, and the conversion has to be
-- visible rather than folded into a number.
CREATE TABLE IF NOT EXISTS supplier_items (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id              TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  sku_id                   TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,

  supplier_sku             TEXT,
  supplier_description     TEXT,

  purchase_unit            TEXT NOT NULL DEFAULT 'unit',
  units_per_purchase_unit  INTEGER NOT NULL DEFAULT 1 CHECK (units_per_purchase_unit > 0),
  -- Per inventory unit, not per case: comparing suppliers who pack differently
  -- is meaningless otherwise.
  last_unit_cost           REAL,
  last_cost_at             TEXT,

  lead_time_days           INTEGER,
  -- Both are counted in purchase units, the way a supplier states them.
  minimum_order_quantity   INTEGER,
  order_multiple           INTEGER,

  is_preferred             INTEGER NOT NULL DEFAULT 0 CHECK (is_preferred IN (0, 1)),
  is_active                INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  notes                    TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_items ON supplier_items(workspace_id, supplier_id, sku_id);
CREATE INDEX IF NOT EXISTS idx_supplier_items_sku ON supplier_items(workspace_id, sku_id, is_active);

-- Optional per-SKU replenishment settings. Deliberately optional: requiring a
-- policy on every line before Foundry will help would mean it helps nobody on
-- day one. Where there is no policy, the engine derives one from history and
-- says that it did.
CREATE TABLE IF NOT EXISTS reorder_policies (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id                 TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  -- Null means the policy covers the whole workspace rather than one location.
  location_id            TEXT REFERENCES locations(id) ON DELETE CASCADE,

  reorder_point          INTEGER,
  target_stock           INTEGER,
  safety_stock           INTEGER,
  preferred_supplier_id  TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  default_order_quantity INTEGER,
  lead_time_days         INTEGER,

  -- Who decided this: a person, or Foundry proposing from history.
  source                 TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'foundry')),
  notes                  TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reorder_policies
  ON reorder_policies(workspace_id, sku_id, COALESCE(location_id, ''));

-- An intention to buy. Immutable once approved in the ways that matter: the
-- quantities and costs a person approved are what the receiving screen checks
-- against, so editing them afterwards would make the approval meaningless.
CREATE TABLE IF NOT EXISTS purchase_orders (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  po_number               TEXT NOT NULL,
  supplier_id             TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,

  status                  TEXT NOT NULL CHECK (status IN
                            ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'ORDERED',
                             'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')),

  order_date              TEXT,
  expected_date           TEXT,
  -- Whether the expected date came from a real lead time or was just assumed.
  -- "Four days late" is only fair to say when the date meant something.
  expected_date_source    TEXT CHECK (expected_date_source IN ('supplier_item', 'supplier_default', 'manual', 'unknown')),

  destination_location_id TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  currency                TEXT NOT NULL DEFAULT 'USD',
  notes                   TEXT,

  -- Where this came from, so "Foundry prepared this" is auditable.
  source                  TEXT NOT NULL DEFAULT 'manual'
                            CHECK (source IN ('manual', 'foundry_recommendation', 'instruction')),
  source_detail           TEXT NOT NULL DEFAULT '{}',

  created_by_user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_user_id     TEXT REFERENCES users(id) ON DELETE RESTRICT,
  cancelled_by_user_id    TEXT REFERENCES users(id) ON DELETE RESTRICT,
  cancel_reason           TEXT,

  integrity_hash          TEXT NOT NULL DEFAULT '',
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  approved_at             TEXT,
  ordered_at              TEXT,
  completed_at            TEXT,
  cancelled_at            TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_orders_number ON purchase_orders(workspace_id, po_number);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_workspace ON purchase_orders(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(workspace_id, supplier_id, status);

-- One product on one order. Quantities are stored twice on purpose: in the
-- supplier's units because that is what was ordered, and in inventory units
-- because that is what will arrive. Deriving either on the fly would let a
-- later change to the pack size silently rewrite history.
CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id                        TEXT PRIMARY KEY,
  workspace_id              TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  purchase_order_id         TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_number               INTEGER NOT NULL,

  sku_id                    TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  supplier_item_id          TEXT REFERENCES supplier_items(id) ON DELETE SET NULL,
  supplier_sku              TEXT,
  description               TEXT,

  purchase_unit             TEXT NOT NULL DEFAULT 'unit',
  units_per_purchase_unit   INTEGER NOT NULL DEFAULT 1 CHECK (units_per_purchase_unit > 0),
  quantity_purchase_units   INTEGER NOT NULL CHECK (quantity_purchase_units > 0),
  quantity_units            INTEGER NOT NULL CHECK (quantity_units > 0),
  quantity_received_units   INTEGER NOT NULL DEFAULT 0,

  unit_cost                 REAL,          -- per inventory unit
  line_total                REAL,
  destination_location_id   TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  notes                     TEXT,
  created_at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_po_lines_order ON purchase_order_lines(purchase_order_id, line_number);
CREATE INDEX IF NOT EXISTS idx_po_lines_sku ON purchase_order_lines(workspace_id, sku_id);

-- One delivery against one order, claimed under a unique key before any stock
-- is written. This is what makes a retried "receive" return the first result
-- instead of receiving the shipment twice.
CREATE TABLE IF NOT EXISTS purchase_order_receipts (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  purchase_order_id    TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  idempotency_key      TEXT NOT NULL,
  received_by_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  received_at          TEXT NOT NULL,
  reference            TEXT,                       -- delivery note, packing list
  note                 TEXT,
  -- Set when a person knowingly accepted more than was ordered.
  over_receipt_approved INTEGER NOT NULL DEFAULT 0 CHECK (over_receipt_approved IN (0, 1)),
  movement_group_ids   TEXT NOT NULL DEFAULT '[]',
  result               TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_po_receipts_key
  ON purchase_order_receipts(workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_po_receipts_order ON purchase_order_receipts(purchase_order_id, received_at);

CREATE TABLE IF NOT EXISTS purchase_order_receipt_lines (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  receipt_id          TEXT NOT NULL REFERENCES purchase_order_receipts(id) ON DELETE CASCADE,
  purchase_order_line_id TEXT NOT NULL REFERENCES purchase_order_lines(id) ON DELETE CASCADE,
  sku_id              TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  location_id         TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,

  quantity_units      INTEGER NOT NULL CHECK (quantity_units > 0),
  lot_id              TEXT REFERENCES lots(id) ON DELETE SET NULL,
  lot_code            TEXT,
  expires_at          TEXT,
  serials             TEXT NOT NULL DEFAULT '[]',
  -- How far this line went past what was ordered, for the discrepancy record.
  over_by_units       INTEGER NOT NULL DEFAULT 0,
  movement_ids        TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_po_receipt_lines_receipt ON purchase_order_receipt_lines(receipt_id);
CREATE INDEX IF NOT EXISTS idx_po_receipt_lines_line ON purchase_order_receipt_lines(purchase_order_line_id);

-- The order's life, in order.
CREATE TABLE IF NOT EXISTS purchase_order_events (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  event             TEXT NOT NULL,
  detail            TEXT NOT NULL DEFAULT '{}',
  actor_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL
);
-- Queries order by (created_at, rowid) so events sharing a timestamp keep their
-- insertion order; rowid cannot appear in an index, only in the ORDER BY.
CREATE INDEX IF NOT EXISTS idx_po_events_order ON purchase_order_events(purchase_order_id, created_at);
