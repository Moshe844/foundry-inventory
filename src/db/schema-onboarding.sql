-- Foundry Inventory : onboarding and takeover
--
-- Missions 1–6 assume an inventory that Foundry set up. Almost no real customer
-- arrives that way. They arrive with a spreadsheet, or another system, or four
-- files that disagree with each other — and the job is to take the inventory
-- over, not to hand them an import template and wish them luck.
--
-- Nothing here holds inventory. Balances still come from Mission 1 movements
-- and catalog records still come from the Mission 5 import engine. These tables
-- record how a workspace was onboarded, what it was given, what Foundry made of
-- it, which conflicts a person settled, and whether the result actually
-- reconciles with the source.

-- How one workspace is being brought into Foundry. One row per workspace: the
-- path chosen at the start, and where it has got to.
CREATE TABLE IF NOT EXISTS workspace_onboarding (
  workspace_id      TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,

  -- What the customer said they have today.
  path              TEXT NOT NULL CHECK (path IN ('fresh', 'spreadsheet', 'software', 'messy', 'undecided')),
  -- Set when Foundry picked the path from a description rather than a button.
  path_chosen_by    TEXT NOT NULL DEFAULT 'customer' CHECK (path_chosen_by IN ('customer', 'foundry')),
  path_reason       TEXT,
  described_as      TEXT,

  status            TEXT NOT NULL DEFAULT 'choosing' CHECK (status IN
                      ('choosing', 'collecting', 'understanding', 'reviewing', 'migrating', 'ready', 'abandoned')),

  -- Which system they are coming from, when they said. Free text on purpose:
  -- claiming to recognise a system Foundry has no connector for would be a lie
  -- dressed as a dropdown.
  external_system   TEXT,

  started_at        TEXT NOT NULL,
  completed_at      TEXT,
  updated_at        TEXT NOT NULL
);

-- A file (or paste) a customer handed over, kept as evidence.
--
-- The hash is the point: it makes a source immutable in the record, lets a
-- re-upload of the same bytes be recognised rather than duplicated, and means a
-- reconciliation can name exactly which bytes it reconciled against.
CREATE TABLE IF NOT EXISTS migration_sources (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  uploaded_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  name              TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('xlsx', 'csv', 'paste', 'connector_export')),
  content_hash      TEXT NOT NULL,
  bytes             INTEGER NOT NULL DEFAULT 0,
  -- The file itself, exactly as handed over. Kept so consolidation can re-read
  -- the real rows rather than a summary of them, so a reconciliation can be
  -- recomputed against the original later, and so "here is what you gave us"
  -- is evidence rather than an assurance.
  content           BLOB,

  -- What Foundry made of it, deterministically: sheets, headers, samples,
  -- row counts, and the totals it will later reconcile against.
  profile           TEXT NOT NULL DEFAULT '{}',
  -- What this file appears to be for: a catalog, a stock count, a supplier
  -- list. Inferred, and always shown as an inference.
  inferred_purpose  TEXT,
  purpose_confidence TEXT CHECK (purpose_confidence IN ('high', 'medium', 'low')),
  -- Where a date could be established from the file's own contents. Null when
  -- nothing in it says how old it is — which is most of the time.
  observed_at       TEXT,
  freshness_basis   TEXT,

  excluded          INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_migration_sources_workspace ON migration_sources(workspace_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_migration_sources_hash
  ON migration_sources(workspace_id, content_hash);

-- What Foundry proposes to build out of one or more sources.
CREATE TABLE IF NOT EXISTS consolidation_plans (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  source_ids         TEXT NOT NULL DEFAULT '[]',
  source_hashes      TEXT NOT NULL DEFAULT '[]',

  -- The configuration Foundry would apply, in the Mission 2 plan shape, so the
  -- same applier configures the engine whichever path the customer came in on.
  proposed_configuration TEXT NOT NULL DEFAULT '{}',
  configuration_source   TEXT NOT NULL DEFAULT 'inferred'
                           CHECK (configuration_source IN ('inferred', 'existing', 'described')),

  proposed_locations TEXT NOT NULL DEFAULT '[]',
  location_mappings  TEXT NOT NULL DEFAULT '{}',
  proposed_records   TEXT NOT NULL DEFAULT '{}',
  overlaps           TEXT NOT NULL DEFAULT '[]',
  excluded_data      TEXT NOT NULL DEFAULT '[]',

  -- What the sources say, counted before anything is created. This is the
  -- figure reconciliation compares against afterwards.
  expected_totals    TEXT NOT NULL DEFAULT '{}',

  confidence         TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low')),
  status             TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                       ('DRAFT', 'AWAITING_DECISIONS', 'READY', 'APPROVED', 'MIGRATING', 'COMPLETED', 'CANCELLED')),

  plan_version       INTEGER NOT NULL DEFAULT 1,
  integrity_hash     TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  approved_at        TEXT,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_consolidation_plans_workspace
  ON consolidation_plans(workspace_id, created_at DESC);

-- One thing worth a person's attention, and how it was settled.
--
-- Foundry resolves what is unambiguous — the same SKU written two ways, a
-- location spelled three ways — and brings the rest here. A conflict with no
-- decision blocks the migration rather than being silently resolved: choosing
-- between two quantities on a coin toss is how a migration quietly corrupts a
-- business's stock figures.
CREATE TABLE IF NOT EXISTS consolidation_conflicts (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id           TEXT NOT NULL REFERENCES consolidation_plans(id) ON DELETE CASCADE,

  kind              TEXT NOT NULL CHECK (kind IN
                      ('same_product_different_names', 'duplicate_sku', 'quantity_conflict',
                       'location_naming', 'duplicate_serial', 'lot_conflict', 'missing_identifier',
                       'possible_stale_source')),
  severity          TEXT NOT NULL DEFAULT 'review' CHECK (severity IN ('blocking', 'review', 'resolved_automatically')),

  subject           TEXT NOT NULL,
  detail            TEXT NOT NULL DEFAULT '{}',
  evidence          TEXT NOT NULL DEFAULT '[]',
  options           TEXT NOT NULL DEFAULT '[]',
  recommended_option TEXT,
  recommendation_reason TEXT,

  decision          TEXT,
  decided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consolidation_conflicts_plan
  ON consolidation_conflicts(plan_id, severity, kind);

-- One attempt to take the inventory over. Claimed under a unique key before
-- anything is created, so a retried request finishes the first migration
-- instead of building a second copy of the customer's inventory.
CREATE TABLE IF NOT EXISTS migration_runs (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id           TEXT NOT NULL REFERENCES consolidation_plans(id) ON DELETE CASCADE,
  idempotency_key   TEXT NOT NULL,
  run_by_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  status            TEXT NOT NULL CHECK (status IN ('RUNNING', 'RECONCILING', 'VERIFIED', 'MISMATCHED', 'FAILED')),
  stage             TEXT NOT NULL DEFAULT 'starting',

  import_ids        TEXT NOT NULL DEFAULT '[]',
  result            TEXT NOT NULL DEFAULT '{}',
  error_message     TEXT,
  started_at        TEXT NOT NULL,
  finished_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_migration_runs_key
  ON migration_runs(workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_migration_runs_workspace ON migration_runs(workspace_id, started_at DESC);

-- Source totals against Foundry totals, counted separately and compared.
--
-- Kept apart from the run on purpose: "the import finished" and "the numbers
-- match" are different claims, and a migration that reports success because
-- commands completed is how a business discovers three months later that its
-- opening stock was wrong.
CREATE TABLE IF NOT EXISTS migration_reconciliations (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  migration_run_id  TEXT NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,

  verified          INTEGER NOT NULL CHECK (verified IN (0, 1)),
  checks            TEXT NOT NULL DEFAULT '[]',
  expected          TEXT NOT NULL DEFAULT '{}',
  observed          TEXT NOT NULL DEFAULT '{}',
  discrepancies     TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_migration_reconciliations_run
  ON migration_reconciliations(migration_run_id);

-- A connection to an external inventory system.
--
-- The architecture exists so Foundry can operate on top of a system it does not
-- own. No connector is registered against a real vendor until there are real
-- credentials and real test access — a row here always describes something that
-- genuinely connects, never a logo on a page.
CREATE TABLE IF NOT EXISTS workspace_connectors (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_key     TEXT NOT NULL,
  display_name      TEXT NOT NULL,

  status            TEXT NOT NULL DEFAULT 'disconnected'
                      CHECK (status IN ('disconnected', 'connected', 'error')),
  -- What this connector can actually do, discovered from the connector itself
  -- rather than assumed. Mission 4 refuses to propose an action the connected
  -- system cannot perform.
  capabilities      TEXT NOT NULL DEFAULT '[]',
  -- Credentials never live here. This holds a reference to wherever they are
  -- held, so a plan, a prompt or a log can never carry a secret by accident.
  credential_ref    TEXT,
  last_synced_at    TEXT,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_connectors
  ON workspace_connectors(workspace_id, connector_key);
