-- Mission 5: warehouse execution around the canonical inventory engine.
-- Locations (including bins) own stock. Tasks and scans coordinate work but
-- never become an alternate balance ledger.

CREATE INDEX IF NOT EXISTS idx_locations_parent
  ON locations(workspace_id, parent_location_id, pick_sequence, name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_barcode
  ON locations(workspace_id, barcode) WHERE barcode IS NOT NULL;

CREATE TABLE IF NOT EXISTS warehouse_barcode_aliases (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  barcode       TEXT NOT NULL COLLATE NOCASE,
  target_kind   TEXT NOT NULL CHECK (target_kind IN ('sku','location','lot','serial','container')),
  target_id     TEXT NOT NULL,
  label         TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    TEXT NOT NULL,
  UNIQUE (workspace_id, barcode)
);
CREATE INDEX IF NOT EXISTS idx_warehouse_alias_target
  ON warehouse_barcode_aliases(workspace_id, target_kind, target_id);

CREATE TABLE IF NOT EXISTS warehouse_containers (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  barcode       TEXT NOT NULL COLLATE NOCASE,
  kind          TEXT NOT NULL CHECK (kind IN ('tote','carton','pallet','package','other')),
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SEALED','SHIPPED','VOID')),
  location_id   TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  note          TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workspace_id, code),
  UNIQUE (workspace_id, barcode)
);
CREATE INDEX IF NOT EXISTS idx_warehouse_containers_location
  ON warehouse_containers(workspace_id, location_id, status);

CREATE TABLE IF NOT EXISTS warehouse_container_contents (
  container_id  TEXT NOT NULL REFERENCES warehouse_containers(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  identity_key  TEXT NOT NULL,
  sku_id        TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  lot_id        TEXT REFERENCES lots(id) ON DELETE RESTRICT,
  serial_unit_id TEXT REFERENCES serial_units(id) ON DELETE RESTRICT,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  added_at      TEXT NOT NULL,
  PRIMARY KEY (container_id, identity_key)
);

CREATE TABLE IF NOT EXISTS warehouse_putaway_rules (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id        TEXT REFERENCES skus(id) ON DELETE CASCADE,
  from_location_id TEXT REFERENCES locations(id) ON DELETE CASCADE,
  destination_location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  priority      INTEGER NOT NULL DEFAULT 100,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    TEXT NOT NULL,
  UNIQUE (workspace_id, sku_id, from_location_id, destination_location_id)
);
CREATE INDEX IF NOT EXISTS idx_warehouse_putaway_match
  ON warehouse_putaway_rules(workspace_id, sku_id, from_location_id, is_active, priority);

CREATE TABLE IF NOT EXISTS warehouse_tasks (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_number   INTEGER NOT NULL,
  task_type     TEXT NOT NULL CHECK (task_type IN ('RECEIVE','PUTAWAY','PICK','COUNT','TRANSFER')),
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','PAUSED','COMPLETED','CANCELLED')),
  title         TEXT NOT NULL,
  reference     TEXT,
  container_id  TEXT REFERENCES warehouse_containers(id) ON DELETE SET NULL,
  assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  started_at    TEXT,
  completed_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workspace_id, task_number)
);
CREATE INDEX IF NOT EXISTS idx_warehouse_tasks_queue
  ON warehouse_tasks(workspace_id, status, task_type, created_at);

CREATE TABLE IF NOT EXISTS warehouse_task_lines (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id        TEXT NOT NULL REFERENCES warehouse_tasks(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  sku_id        TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  from_location_id TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  to_location_id TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  lot_id        TEXT REFERENCES lots(id) ON DELETE RESTRICT,
  planned_quantity INTEGER NOT NULL CHECK (planned_quantity > 0),
  processed_quantity INTEGER NOT NULL DEFAULT 0 CHECK (processed_quantity >= 0),
  counted_quantity INTEGER NOT NULL DEFAULT 0 CHECK (counted_quantity >= 0),
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','COMPLETED','BLOCKED')),
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (task_id, position)
);
CREATE INDEX IF NOT EXISTS idx_warehouse_task_lines_task
  ON warehouse_task_lines(task_id, status, position);

CREATE TABLE IF NOT EXISTS warehouse_scan_events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id        TEXT NOT NULL REFERENCES warehouse_tasks(id) ON DELETE CASCADE,
  task_line_id   TEXT REFERENCES warehouse_task_lines(id) ON DELETE SET NULL,
  client_scan_id TEXT NOT NULL,
  device_id      TEXT,
  location_barcode TEXT,
  item_barcode   TEXT,
  lot_barcode    TEXT,
  serial_barcode TEXT,
  quantity       INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL CHECK (status IN ('ACCEPTED','REJECTED','DUPLICATE')),
  message        TEXT NOT NULL,
  movement_group_id TEXT,
  movement_ids_json TEXT NOT NULL DEFAULT '[]',
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  scanned_at    TEXT NOT NULL,
  UNIQUE (workspace_id, client_scan_id)
);
CREATE INDEX IF NOT EXISTS idx_warehouse_scan_task
  ON warehouse_scan_events(task_id, seq DESC);

CREATE TRIGGER IF NOT EXISTS warehouse_scan_events_no_update
BEFORE UPDATE ON warehouse_scan_events BEGIN
  SELECT RAISE(ABORT, 'warehouse scan events are immutable');
END;
CREATE TRIGGER IF NOT EXISTS warehouse_scan_events_no_delete
BEFORE DELETE ON warehouse_scan_events BEGIN
  SELECT RAISE(ABORT, 'warehouse scan events are immutable');
END;
