-- Foundry Inventory : data import (Mission 5)
--
-- Foundry can now do the data-entry work: read a customer's file, work out what
-- it means, and create the catalog and opening stock for them. What it may not
-- do is write inventory directly — every product goes through the catalog
-- service and every unit of opening stock goes through a Mission 1 receive, so
-- the ledger explains where each figure came from.
--
-- These tables record the interpretation and its outcome, never the inventory.

-- One attempt to bring a file (or a paste) into one workspace.
CREATE TABLE IF NOT EXISTS import_plans (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_user_id  TEXT REFERENCES users(id) ON DELETE RESTRICT,
  scope_confirmed_at   TEXT,

  source_name          TEXT NOT NULL,
  source_kind          TEXT NOT NULL CHECK (source_kind IN ('xlsx', 'csv', 'paste')),
  source_hash          TEXT NOT NULL,          -- the bytes we read, so a re-upload is recognisable
  source_bytes         INTEGER NOT NULL DEFAULT 0,

  detected_type        TEXT NOT NULL CHECK (detected_type IN
                         ('catalog', 'inventory', 'variant_inventory', 'serials', 'lots', 'receiving', 'unknown')),
  sheet_name           TEXT,
  sheet_index          INTEGER NOT NULL DEFAULT 0,

  source_columns       TEXT NOT NULL DEFAULT '[]',   -- what the file actually had
  field_mappings       TEXT NOT NULL DEFAULT '{}',   -- field -> column index
  transformations      TEXT NOT NULL DEFAULT '{}',
  tracking_model       TEXT NOT NULL DEFAULT '{}',   -- from the Mission 2 configuration
  location_mappings    TEXT NOT NULL DEFAULT '{}',   -- file wording -> location id
  default_location_id  TEXT REFERENCES locations(id) ON DELETE SET NULL,

  records_detected     INTEGER NOT NULL DEFAULT 0,
  records_valid        INTEGER NOT NULL DEFAULT 0,
  records_invalid      INTEGER NOT NULL DEFAULT 0,
  warnings             TEXT NOT NULL DEFAULT '[]',
  conflicts            TEXT NOT NULL DEFAULT '[]',
  assumptions          TEXT NOT NULL DEFAULT '[]',

  approval_status      TEXT NOT NULL CHECK (approval_status IN
                         ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'CANCELLED')),
  status               TEXT NOT NULL CHECK (status IN
                         ('ANALYSING', 'READY', 'EXECUTING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED')),

  plan_version         INTEGER NOT NULL DEFAULT 1,
  integrity_hash       TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  approved_at          TEXT,
  completed_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_import_plans_workspace ON import_plans(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_plans_hash ON import_plans(workspace_id, source_hash);

-- Every row of the source, with what Foundry made of it. Kept whether or not it
-- imported: "17 rows skipped" is only meaningful if you can see which 17.
CREATE TABLE IF NOT EXISTS import_rows (
  id             TEXT PRIMARY KEY,
  import_id      TEXT NOT NULL REFERENCES import_plans(id) ON DELETE CASCADE,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  row_number     INTEGER NOT NULL,             -- the line in the customer's file
  raw            TEXT NOT NULL DEFAULT '{}',   -- exactly what the file said
  parsed         TEXT NOT NULL DEFAULT '{}',   -- what Foundry read it as

  status         TEXT NOT NULL CHECK (status IN
                   ('VALID', 'INVALID', 'NEEDS_REVIEW', 'EXCLUDED', 'IMPORTED', 'FAILED', 'SKIPPED')),
  problems       TEXT NOT NULL DEFAULT '[]',
  resolution     TEXT,                          -- how a person settled a conflict

  -- What it became, once it ran.
  item_id        TEXT REFERENCES items(id) ON DELETE SET NULL,
  sku_id         TEXT REFERENCES skus(id) ON DELETE SET NULL,
  lot_id         TEXT REFERENCES lots(id) ON DELETE SET NULL,
  location_id    TEXT REFERENCES locations(id) ON DELETE SET NULL,
  movement_ids   TEXT NOT NULL DEFAULT '[]',
  quantity       INTEGER,

  created_at     TEXT NOT NULL,
  imported_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_import_rows_plan ON import_rows(import_id, row_number);
CREATE INDEX IF NOT EXISTS idx_import_rows_status ON import_rows(import_id, status);

-- One row per attempt to run an import, claimed before any writing starts.
-- This is what makes a retried browser request return the first result instead
-- of creating two thousand products twice.
CREATE TABLE IF NOT EXISTS import_executions (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  import_id           TEXT NOT NULL REFERENCES import_plans(id) ON DELETE CASCADE,
  idempotency_key     TEXT NOT NULL,
  executed_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status              TEXT NOT NULL CHECK (status IN ('EXECUTING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED')),

  -- Progress that is read from what has actually been written, never guessed.
  stage               TEXT NOT NULL DEFAULT 'starting',
  items_created       INTEGER NOT NULL DEFAULT 0,
  skus_created        INTEGER NOT NULL DEFAULT 0,
  lots_created        INTEGER NOT NULL DEFAULT 0,
  serials_created     INTEGER NOT NULL DEFAULT 0,
  rows_imported       INTEGER NOT NULL DEFAULT 0,
  rows_failed         INTEGER NOT NULL DEFAULT 0,
  units_established   INTEGER NOT NULL DEFAULT 0,
  cancel_requested    INTEGER NOT NULL DEFAULT 0,

  result              TEXT NOT NULL DEFAULT '{}',
  error_message       TEXT,
  started_at          TEXT NOT NULL,
  finished_at         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_import_executions_key
  ON import_executions(workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_import_executions_plan ON import_executions(import_id);

-- What the resulting inventory actually looked like, counted afterwards.
CREATE TABLE IF NOT EXISTS import_verifications (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  import_id      TEXT NOT NULL REFERENCES import_plans(id) ON DELETE CASCADE,
  execution_id   TEXT NOT NULL REFERENCES import_executions(id) ON DELETE CASCADE,
  verified       INTEGER NOT NULL CHECK (verified IN (0, 1)),
  checks         TEXT NOT NULL DEFAULT '[]',
  observed       TEXT NOT NULL DEFAULT '{}',
  problems       TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_verifications_plan ON import_verifications(import_id);

-- A controlled request to remove some or all products created by one import.
-- The import rows are the provenance: existing products touched by that file
-- are never candidates, and approval acts only on IDs shown in the snapshot.
CREATE TABLE IF NOT EXISTS import_removal_proposals (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  import_plan_id        TEXT NOT NULL REFERENCES import_plans(id) ON DELETE CASCADE,
  requested_by_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_user_id   TEXT REFERENCES users(id) ON DELETE RESTRICT,
  instruction           TEXT NOT NULL,
  snapshot              TEXT NOT NULL DEFAULT '{}',
  integrity_hash        TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','COMPLETED','CANCELLED')),
  result                TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL,
  completed_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_import_removals_workspace
  ON import_removal_proposals(workspace_id, created_at DESC);
