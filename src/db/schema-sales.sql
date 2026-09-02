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

-- Telling the customer (Mission 14.6)
--
-- The same outbox shape as supplier communication, for the same reason:
-- preparing a message is not sending one, and Foundry writes nothing to a
-- customer that the owner has not seen unless they have said, in a setting,
-- that it may.
--
-- The body is built from records, never from a model. A shipping notice is
-- read by somebody who is owed goods: a hallucinated tracking number or an
-- invented delivery date is worse than no notice at all.

CREATE TABLE IF NOT EXISTS customer_communications (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id         TEXT REFERENCES customers(id) ON DELETE SET NULL,
  sales_order_id      TEXT REFERENCES sales_orders(id) ON DELETE SET NULL,
  shipment_id         TEXT REFERENCES sales_shipments(id) ON DELETE SET NULL,
  channel             TEXT NOT NULL DEFAULT 'email',
  recipient           TEXT,
  subject             TEXT NOT NULL,
  body                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'PREPARED'
                        CHECK (status IN ('PREPARED','QUEUED','SENDING','SENT','FAILED','CANCELLED')),
  transport           TEXT,
  external_message_id TEXT,
  external_thread_id  TEXT,
  message_kind        TEXT NOT NULL DEFAULT 'shipping_notice',
  connector_id        TEXT,
  approved_by_user_id TEXT,
  approved_at         TEXT,
  idempotency_key     TEXT NOT NULL,
  error_message       TEXT,
  created_at          TEXT NOT NULL,
  queued_at           TEXT,
  sent_at             TEXT,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_communications_key
  ON customer_communications(workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_customer_communications_order
  ON customer_communications(workspace_id, sales_order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_communications_shipment
  ON customer_communications(workspace_id, shipment_id);
CREATE INDEX IF NOT EXISTS idx_customer_communications_open
  ON customer_communications(workspace_id, status, created_at);

-- What a workspace has decided customers may be told. One row per workspace;
-- absent means the defaults below, which prepare a notice and send nothing.
CREATE TABLE IF NOT EXISTS customer_communication_policy (
  workspace_id     TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  shipping_notice  TEXT NOT NULL DEFAULT 'prepare'
                     CHECK (shipping_notice IN ('off','prepare','send')),
  connector_id     TEXT,
  business_name    TEXT,
  reply_to         TEXT,
  signature        TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- What a customer has to pay, and when (Mission 15)
--
-- Terms belong to the customer, not to the order. "ABC School pays 30% up
-- front" is a fact about a relationship somebody agreed once, and re-deciding
-- it per order is how a business ends up shipping unpaid goods to the one
-- customer who never pays.
--
-- A workspace default exists so a new customer inherits the house rule rather
-- than nothing at all. Absent both, the answer is the least surprising one:
-- payment is due, and nothing is held.

CREATE TABLE IF NOT EXISTS customer_payment_terms (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- NULL means the house rule for every customer without one of their own.
  customer_id         TEXT REFERENCES customers(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('ON_ACCOUNT','BEFORE_FULFILMENT','DEPOSIT')),
  -- DEPOSIT only: how much is wanted up front. A percentage of the order, or a
  -- flat amount; never both, because two answers to "how much now" is one too
  -- many.
  deposit_percent     REAL CHECK (deposit_percent IS NULL OR (deposit_percent > 0 AND deposit_percent <= 100)),
  deposit_minor       INTEGER CHECK (deposit_minor IS NULL OR deposit_minor > 0),
  -- ON_ACCOUNT only: days from the invoice date until the balance is due.
  net_days            INTEGER CHECK (net_days IS NULL OR net_days >= 0),
  -- Whether the remaining balance blocks the parcel leaving.
  hold_shipping       INTEGER NOT NULL DEFAULT 0 CHECK (hold_shipping IN (0,1)),
  -- Credit somebody actually agreed to give, as opposed to credit taken.
  credit_approved     INTEGER NOT NULL DEFAULT 0 CHECK (credit_approved IN (0,1)),
  credit_limit_minor  INTEGER CHECK (credit_limit_minor IS NULL OR credit_limit_minor >= 0),
  note                TEXT,
  agreed_by_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (deposit_percent IS NULL OR deposit_minor IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_payment_terms
  ON customer_payment_terms(workspace_id, IFNULL(customer_id, ''));

-- An owner deciding, in words, to let one order past its own hold.
--
-- Kept rather than applied silently: "we shipped this one unpaid" is exactly
-- the thing somebody asks about three months later, and a hold that can be
-- lifted without trace is not a hold.
CREATE TABLE IF NOT EXISTS sales_order_payment_overrides (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sales_order_id     TEXT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  reason             TEXT,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  UNIQUE (workspace_id, sales_order_id)
);
