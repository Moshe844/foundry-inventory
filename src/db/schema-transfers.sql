-- Mission 6: durable internal transfers.
--
-- A transfer is a business document, not a pair of balance updates. Stock is
-- reserved while approved/picked, becomes custody in transit only when the
-- dispatch movement posts, and becomes destination on-hand only when an
-- accepted receipt movement posts.

CREATE TABLE IF NOT EXISTS inventory_transfers (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transfer_number          TEXT NOT NULL,
  source_location_id       TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  destination_location_id  TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  status                   TEXT NOT NULL DEFAULT 'REQUESTED'
                             CHECK (status IN ('REQUESTED','APPROVED','PICKED','SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  expected_arrival_date    TEXT,
  reason                   TEXT,
  notes                    TEXT,
  reference                TEXT,
  decision_detail          TEXT NOT NULL DEFAULT '{}',
  legacy_group_id          TEXT,
  version                  INTEGER NOT NULL DEFAULT 1,
  requested_by_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  picked_by_user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  dispatched_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  received_by_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  cancelled_by_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  requested_at             TEXT NOT NULL,
  approved_at              TEXT,
  picked_at                TEXT,
  shipped_at               TEXT,
  in_transit_at            TEXT,
  received_at              TEXT,
  cancelled_at             TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  CHECK (source_location_id <> destination_location_id),
  UNIQUE (workspace_id, transfer_number),
  UNIQUE (workspace_id, legacy_group_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_transfers_open
  ON inventory_transfers(workspace_id, status, expected_arrival_date, created_at);

CREATE TABLE IF NOT EXISTS inventory_transfer_lines (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transfer_id           TEXT NOT NULL REFERENCES inventory_transfers(id) ON DELETE CASCADE,
  sku_id                TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  lot_id                TEXT REFERENCES lots(id) ON DELETE RESTRICT,
  requested_quantity    INTEGER NOT NULL CHECK (requested_quantity > 0),
  approved_quantity     INTEGER NOT NULL DEFAULT 0 CHECK (approved_quantity >= 0),
  picked_quantity       INTEGER NOT NULL DEFAULT 0 CHECK (picked_quantity >= 0),
  shipped_quantity      INTEGER NOT NULL DEFAULT 0 CHECK (shipped_quantity >= 0),
  received_quantity     INTEGER NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  lost_quantity         INTEGER NOT NULL DEFAULT 0 CHECK (lost_quantity >= 0),
  damaged_quantity      INTEGER NOT NULL DEFAULT 0 CHECK (damaged_quantity >= 0),
  cancelled_quantity    INTEGER NOT NULL DEFAULT 0 CHECK (cancelled_quantity >= 0),
  dispatched_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (dispatched_cost_minor >= 0),
  received_cost_minor   INTEGER NOT NULL DEFAULT 0 CHECK (received_cost_minor >= 0),
  written_off_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (written_off_cost_minor >= 0),
  cost_status           TEXT NOT NULL DEFAULT 'NOT_RECORDED'
                          CHECK (cost_status IN ('NOT_RECORDED','RECORDED')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (transfer_id, sku_id, lot_id),
  CHECK (approved_quantity <= requested_quantity),
  CHECK (picked_quantity <= approved_quantity),
  CHECK (shipped_quantity <= picked_quantity),
  CHECK (received_quantity + lost_quantity + damaged_quantity <= shipped_quantity)
);
CREATE INDEX IF NOT EXISTS idx_inventory_transfer_lines_sku
  ON inventory_transfer_lines(workspace_id, sku_id, transfer_id);

CREATE TABLE IF NOT EXISTS inventory_transfer_serials (
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transfer_line_id  TEXT NOT NULL REFERENCES inventory_transfer_lines(id) ON DELETE CASCADE,
  serial_unit_id    TEXT NOT NULL REFERENCES serial_units(id) ON DELETE RESTRICT,
  state             TEXT NOT NULL DEFAULT 'REQUESTED'
                      CHECK (state IN ('REQUESTED','PICKED','IN_TRANSIT','RECEIVED','LOST','DAMAGED','CANCELLED')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (transfer_line_id, serial_unit_id)
);

CREATE TABLE IF NOT EXISTS inventory_transfer_events (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transfer_id       TEXT NOT NULL REFERENCES inventory_transfers(id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL,
  detail            TEXT NOT NULL DEFAULT '{}',
  actor_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key   TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_inventory_transfer_events_transfer
  ON inventory_transfer_events(transfer_id, created_at, id);

CREATE TRIGGER IF NOT EXISTS trg_inventory_transfer_event_no_update
BEFORE UPDATE ON inventory_transfer_events BEGIN
  SELECT RAISE(ABORT, 'transfer events are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_inventory_transfer_event_no_delete
BEFORE DELETE ON inventory_transfer_events BEGIN
  SELECT RAISE(ABORT, 'transfer events cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS inventory_transfer_movement_links (
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transfer_line_id  TEXT NOT NULL REFERENCES inventory_transfer_lines(id) ON DELETE CASCADE,
  movement_id       TEXT NOT NULL REFERENCES movements(id) ON DELETE RESTRICT,
  role              TEXT NOT NULL CHECK (role IN ('DISPATCH','RECEIPT')),
  event_id          TEXT NOT NULL REFERENCES inventory_transfer_events(id) ON DELETE RESTRICT,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (movement_id)
);

CREATE TABLE IF NOT EXISTS inventory_transfer_pegs (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transfer_line_id     TEXT NOT NULL REFERENCES inventory_transfer_lines(id) ON DELETE CASCADE,
  sales_order_line_id  TEXT NOT NULL REFERENCES sales_order_lines(id) ON DELETE CASCADE,
  quantity             INTEGER NOT NULL CHECK (quantity > 0),
  priority_snapshot    INTEGER NOT NULL,
  reason               TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  UNIQUE (transfer_line_id, sales_order_line_id)
);
