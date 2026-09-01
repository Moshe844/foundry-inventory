-- Foundry Inventory : core schema
--
-- One engine, four archetypes. A SKU is the unit of stock-keeping:
--   * quantity items have exactly one (default) SKU
--   * variant items have one SKU per option combination
--   * tracking_mode on the item decides whether a SKU's stock is a plain
--     number, a set of identified serial units, or a set of lots.
--
-- `balances` is a derived-but-maintained aggregate. The authoritative history
-- is `movements`, which is append-only and protected by triggers.

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The login identity. One person signs in once and reaches every inventory
-- they belong to; the account is what a future subscription attaches to.
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'free',
  -- The inventory this person was last in. Remembered here rather than in the
  -- session so signing out and back in reopens where they left off.
  last_workspace_id TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_email ON accounts(email);

-- An inventory workspace: the tenant boundary for every other table here.
-- A workspace is NOT a location. One workspace holds many locations.
CREATE TABLE IF NOT EXISTS workspaces (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  owner_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_account_id);

-- Membership: one account's presence in one workspace, with the role it holds
-- *there*. Every movement points at one of these rows, so "who did this" is
-- answered per workspace and survives an account leaving another one.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'accountant')),
  -- Action permissions granted on top of the role, as a JSON array. NULL means
  -- "whatever the role implies"; a value here is an explicit grant or removal.
  permissions   TEXT,
  created_at    TEXT NOT NULL
);
-- An account joins a workspace once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_membership ON users(workspace_id, account_id);
CREATE INDEX IF NOT EXISTS idx_users_workspace ON users(workspace_id);
CREATE INDEX IF NOT EXISTS idx_users_account ON users(account_id);

CREATE TABLE IF NOT EXISTS locations (
  id         TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('warehouse', 'store', 'stockroom', 'truck', 'office', 'other')),
  note       TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);
CREATE INDEX IF NOT EXISTS idx_locations_workspace ON locations(workspace_id);

CREATE TABLE IF NOT EXISTS items (
  id             TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  base_code      TEXT,
  description    TEXT,
  unit_label     TEXT NOT NULL DEFAULT 'unit',
  tracking_mode  TEXT NOT NULL CHECK (tracking_mode IN ('quantity', 'serial', 'lot')),
  has_variants   INTEGER NOT NULL DEFAULT 0 CHECK (has_variants IN (0, 1)),
  allow_negative INTEGER NOT NULL DEFAULT 0 CHECK (allow_negative IN (0, 1)),
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_workspace_name ON items(workspace_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_items_workspace_code ON items(workspace_id, base_code) WHERE base_code IS NOT NULL;

-- Variant option axes, e.g. "Color", "Size".
CREATE TABLE IF NOT EXISTS item_options (
  id       TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_id  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (item_id, name)
);

CREATE TABLE IF NOT EXISTS skus (
  id            TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  barcode       TEXT,
  variant_label TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  position      INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  UNIQUE (workspace_id, code)
);
CREATE INDEX IF NOT EXISTS idx_skus_item ON skus(item_id);

CREATE TABLE IF NOT EXISTS sku_option_values (
  sku_id    TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES item_options(id) ON DELETE CASCADE,
  value     TEXT NOT NULL,
  PRIMARY KEY (sku_id, option_id)
);

-- Aggregate stock per SKU per location. Maintained only through the engine.
CREATE TABLE IF NOT EXISTS balances (
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id      TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  on_hand     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (sku_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_balances_workspace ON balances(workspace_id);
CREATE INDEX IF NOT EXISTS idx_balances_location ON balances(location_id);

CREATE TABLE IF NOT EXISTS lots (
  id          TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id      TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  received_at TEXT,
  expires_at  TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (workspace_id, sku_id, code)
);
CREATE INDEX IF NOT EXISTS idx_lots_workspace_code ON lots(workspace_id, code);

CREATE TABLE IF NOT EXISTS lot_balances (
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lot_id      TEXT NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  quantity    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (lot_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_lot_balances_location ON lot_balances(location_id);

-- One row per physical, individually identified unit.
-- location_id is a single column: a serial can only ever be in one place.
CREATE TABLE IF NOT EXISTS serial_units (
  id          TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id      TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  serial      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('in_stock', 'issued')),
  location_id TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  condition   TEXT NOT NULL DEFAULT 'good' CHECK (condition IN ('good', 'damaged', 'repair', 'unknown')),
  lot_id      TEXT REFERENCES lots(id) ON DELETE SET NULL,
  note        TEXT,
  received_at TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK (
    (status = 'in_stock' AND location_id IS NOT NULL) OR
    (status = 'issued'   AND location_id IS NULL)
  )
);
-- A serial cannot be received twice while it is still active stock.
CREATE UNIQUE INDEX IF NOT EXISTS uq_serial_active
  ON serial_units(workspace_id, sku_id, serial) WHERE status = 'in_stock';
CREATE INDEX IF NOT EXISTS idx_serial_units_sku ON serial_units(sku_id);
CREATE INDEX IF NOT EXISTS idx_serial_units_location ON serial_units(location_id);
CREATE INDEX IF NOT EXISTS idx_serial_units_serial ON serial_units(workspace_id, serial);

-- Append-only ledger. Every balance change in the system has a row here.
-- Transfers write two rows sharing a group_id (one out leg, one in leg).
CREATE TABLE IF NOT EXISTS movements (
  seq                       INTEGER PRIMARY KEY AUTOINCREMENT,
  id                        TEXT NOT NULL UNIQUE,
  workspace_id                    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  group_id                  TEXT NOT NULL,
  operation                 TEXT NOT NULL CHECK (operation IN ('receive', 'issue', 'transfer', 'adjust')),
  leg                       TEXT CHECK (leg IN ('out', 'in')),
  item_id                   TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  sku_id                    TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  location_id               TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  counterparty_location_id  TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  lot_id                    TEXT REFERENCES lots(id) ON DELETE SET NULL,
  serial_unit_id            TEXT REFERENCES serial_units(id) ON DELETE SET NULL,
  quantity_delta            INTEGER NOT NULL CHECK (quantity_delta <> 0),
  balance_after             INTEGER NOT NULL,
  reason_code               TEXT,
  notes                     TEXT,
  reference                 TEXT,
  actor_user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movements_workspace_time ON movements(workspace_id, occurred_at DESC, seq DESC);
CREATE INDEX IF NOT EXISTS idx_movements_group ON movements(group_id);
CREATE INDEX IF NOT EXISTS idx_movements_sku ON movements(sku_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_movements_item ON movements(item_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_movements_location ON movements(location_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_movements_actor ON movements(actor_user_id);

-- History is immutable: the ledger may only be appended to.
CREATE TRIGGER IF NOT EXISTS movements_no_update
BEFORE UPDATE ON movements
BEGIN
  SELECT RAISE(ABORT, 'movements are immutable');
END;

CREATE TRIGGER IF NOT EXISTS movements_no_delete
BEFORE DELETE ON movements
BEGIN
  SELECT RAISE(ABORT, 'movements are immutable');
END;

-- Counted corrections, kept alongside the movement they produced.
CREATE TABLE IF NOT EXISTS adjustments (
  id            TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  movement_id   TEXT NOT NULL REFERENCES movements(id),
  sku_id        TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  location_id   TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  lot_id        TEXT REFERENCES lots(id) ON DELETE SET NULL,
  expected_qty  INTEGER NOT NULL,
  counted_qty   INTEGER NOT NULL,
  reason_code   TEXT NOT NULL,
  notes         TEXT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adjustments_workspace ON adjustments(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
