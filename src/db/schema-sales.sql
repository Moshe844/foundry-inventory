-- Foundry Inventory : Sales Orders & demand commitments (Mission 10)
-- Physical truth remains in balances/movements. These tables record promised
-- demand and its allocation without pretending that committed stock has left.

CREATE TABLE IF NOT EXISTS customers (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  company             TEXT,
  email               TEXT,
  phone               TEXT,
  shipping_address    TEXT,
  notes               TEXT,
  created_by_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_workspace_name
  ON customers(workspace_id, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_customers_workspace
  ON customers(workspace_id, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sales_orders (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id              TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  order_number             TEXT NOT NULL,
  order_date               TEXT NOT NULL,
  needed_by                TEXT,
  fulfillment_location_id  TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  notes                    TEXT,
  reference                TEXT,
  currency                 TEXT NOT NULL DEFAULT 'USD',
  discount_minor           INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor                INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  status                   TEXT NOT NULL DEFAULT 'DRAFT'
                             CHECK (status IN ('DRAFT','CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED','CANCELLED')),
  version                  INTEGER NOT NULL DEFAULT 1,
  created_by_user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_by_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  cancelled_by_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  confirmed_at             TEXT,
  cancelled_at             TEXT,
  completed_at             TEXT,
  cancel_reason            TEXT,
  UNIQUE (workspace_id, order_number)
);
CREATE INDEX IF NOT EXISTS idx_sales_orders_workspace_status
  ON sales_orders(workspace_id, status, needed_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_orders_customer
  ON sales_orders(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sales_order_lines (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sales_order_id      TEXT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  sku_id              TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  quantity_ordered    INTEGER NOT NULL CHECK (quantity_ordered > 0),
  quantity_fulfilled  INTEGER NOT NULL DEFAULT 0 CHECK (quantity_fulfilled >= 0),
  -- Snapshot at the time this line is added. A later catalogue price change
  -- never rewrites a customer commitment already made.
  unit_price_minor    INTEGER CHECK (unit_price_minor IS NULL OR unit_price_minor >= 0),
  price_source_id     TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (sales_order_id, sku_id),
  CHECK (quantity_fulfilled <= quantity_ordered)
);
CREATE INDEX IF NOT EXISTS idx_sales_order_lines_order ON sales_order_lines(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_sales_order_lines_sku ON sales_order_lines(workspace_id, sku_id);

-- Current outstanding commitments. Fulfillment consumes these rows while the
-- immutable sales_order_events table preserves the allocation history.
CREATE TABLE IF NOT EXISTS sales_order_allocations (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sales_order_line_id TEXT NOT NULL REFERENCES sales_order_lines(id) ON DELETE CASCADE,
  location_id         TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (sales_order_line_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_allocations_position
  ON sales_order_allocations(workspace_id, location_id, sales_order_line_id);

CREATE TABLE IF NOT EXISTS sales_order_events (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sales_order_id      TEXT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  event_type          TEXT NOT NULL,
  detail              TEXT NOT NULL DEFAULT '{}',
  actor_user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key     TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_sales_order_events_order
  ON sales_order_events(sales_order_id, created_at);

-- Selling prices are catalogue history, separate from supplier purchase cost.
-- The latest row is current; an identical write is deduplicated by the service.
CREATE TABLE IF NOT EXISTS sku_prices (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id              TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  amount_minor        INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency            TEXT NOT NULL DEFAULT 'USD',
  source              TEXT NOT NULL,
  source_detail       TEXT NOT NULL DEFAULT '{}',
  created_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sku_prices_current
  ON sku_prices(workspace_id, sku_id, created_at DESC);

-- Every conversational or manual price change is previewed before it becomes
-- catalogue truth. Document imports use their own existing approval preview.
CREATE TABLE IF NOT EXISTS price_change_proposals (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id              TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  amount_minor        INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency            TEXT NOT NULL DEFAULT 'USD',
  source_text         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','COMPLETED','CANCELLED')),
  current_price_id    TEXT,
  integrity_hash      TEXT NOT NULL,
  created_by_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  completed_at        TEXT,
  cancelled_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_price_change_proposals_workspace
  ON price_change_proposals(workspace_id, status, created_at DESC);

-- Fulfilment (Mission 14.6)
--
-- A shipment is the physical half of a sales order: what was actually taken
-- off a shelf, put in a box, and handed to a carrier. It is deliberately
-- separate from the order, because one order can leave in three boxes on
-- three days, and a customer asking "where is my order" is really asking
-- about a box, not about a promise.
--
-- Stock does not move when a shipment is created or packed. Allocation
-- already means "spoken for, still here", which is exactly what picked and
-- packed goods are. The inventory issue happens once, at the moment the
-- shipment ships, so that there is one movement per physical departure and
-- COGS lands on the day control actually transferred.

CREATE TABLE IF NOT EXISTS sales_shipments (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sales_order_id         TEXT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  shipment_number        TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('PICKING','PACKED','SHIPPED','DELIVERED','CANCELLED')),
  ship_from_location_id  TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  ship_to_address        TEXT,
  carrier                TEXT,
  service                TEXT,
  tracking_number        TEXT,
  tracking_url           TEXT,
  package_count          INTEGER,
  weight_grams           INTEGER,
  shipping_cost_minor    INTEGER,
  currency               TEXT,
  notes                  TEXT,
  packed_at              TEXT,
  shipped_at             TEXT,
  expected_delivery_date TEXT,
  delivered_at           TEXT,
  created_by_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (workspace_id, shipment_number)
);
CREATE INDEX IF NOT EXISTS idx_sales_shipments_order ON sales_shipments(workspace_id, sales_order_id, status);
CREATE INDEX IF NOT EXISTS idx_sales_shipments_open ON sales_shipments(workspace_id, status, created_at);

CREATE TABLE IF NOT EXISTS sales_shipment_lines (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shipment_id         TEXT NOT NULL REFERENCES sales_shipments(id) ON DELETE CASCADE,
  sales_order_line_id TEXT NOT NULL REFERENCES sales_order_lines(id) ON DELETE CASCADE,
  sku_id              TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  location_id         TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  quantity            INTEGER NOT NULL CHECK (quantity > 0),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (shipment_id, sales_order_line_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_shipment_lines_line
  ON sales_shipment_lines(workspace_id, sales_order_line_id);
