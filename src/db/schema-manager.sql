-- Foundry Inventory : Inventory Manager (Mission 8)
--
-- These tables do not duplicate inventory truth. They persist the manager's
-- inbox, investigations, reconciliation results and conversational references
-- so the operating loop survives restarts without inventing or repeating work.

CREATE TABLE IF NOT EXISTS manager_triggers (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  payload          TEXT NOT NULL DEFAULT '{}',
  idempotency_key  TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  error_message    TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  completed_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_manager_triggers_key
  ON manager_triggers(workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_manager_triggers_pending
  ON manager_triggers(status, created_at);

CREATE TABLE IF NOT EXISTS inventory_investigations (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trigger                 TEXT NOT NULL,
  affected_entities       TEXT NOT NULL DEFAULT '{}',
  observed_difference     TEXT NOT NULL DEFAULT '{}',
  evidence_reviewed       TEXT NOT NULL DEFAULT '[]',
  hypotheses              TEXT NOT NULL DEFAULT '[]',
  evidence_for            TEXT NOT NULL DEFAULT '[]',
  evidence_against        TEXT NOT NULL DEFAULT '[]',
  explained_amount        INTEGER,
  unexplained_amount      INTEGER,
  confidence              TEXT NOT NULL DEFAULT 'low'
                            CHECK (confidence IN ('high', 'medium', 'low')),
  recommended_next_step   TEXT,
  status                  TEXT NOT NULL DEFAULT 'OPEN'
                            CHECK (status IN ('OPEN', 'INVESTIGATING', 'NEEDS_HUMAN', 'RESOLVED', 'INCONCLUSIVE')),
  idempotency_key         TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  resolved_at             TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_investigations_key
  ON inventory_investigations(workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_inventory_investigations_queue
  ON inventory_investigations(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS investigation_events (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  investigation_id  TEXT NOT NULL REFERENCES inventory_investigations(id) ON DELETE CASCADE,
  event             TEXT NOT NULL,
  detail            TEXT NOT NULL DEFAULT '{}',
  actor_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_investigation_events
  ON investigation_events(investigation_id, created_at);

CREATE TABLE IF NOT EXISTS reconciliation_records (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  reference_type    TEXT NOT NULL,
  reference_id      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('VERIFIED', 'FAILED', 'PENDING')),
  expected_state    TEXT NOT NULL DEFAULT '{}',
  observed_state    TEXT NOT NULL DEFAULT '{}',
  checks            TEXT NOT NULL DEFAULT '[]',
  evidence          TEXT NOT NULL DEFAULT '[]',
  idempotency_key   TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reconciliation_records_key
  ON reconciliation_records(workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_reconciliation_records_status
  ON reconciliation_records(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS physical_events (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reported_by_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type           TEXT NOT NULL,
  stated_as            TEXT NOT NULL,
  details              TEXT NOT NULL DEFAULT '{}',
  attachment_name      TEXT,
  attachment_mime      TEXT,
  attachment_content   BLOB,
  matched_entities     TEXT NOT NULL DEFAULT '{}',
  confidence           TEXT NOT NULL DEFAULT 'medium'
                         CHECK (confidence IN ('high', 'medium', 'low')),
  status               TEXT NOT NULL DEFAULT 'RECEIVED'
                         CHECK (status IN ('RECEIVED', 'ROUTED', 'NEEDS_HUMAN', 'COMPLETED', 'FAILED')),
  work_item_id         TEXT REFERENCES work_items(id) ON DELETE SET NULL,
  investigation_id    TEXT REFERENCES inventory_investigations(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_physical_events_workspace
  ON physical_events(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS manager_intents (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  stated_as            TEXT NOT NULL,
  intent_class         TEXT NOT NULL,
  payload              TEXT NOT NULL DEFAULT '{}',
  confidence           TEXT NOT NULL DEFAULT 'medium'
                         CHECK (confidence IN ('high', 'medium', 'low')),
  -- The list of ways a request can end lives in application code, which is the
  -- only place it can be kept honest as new endings are added.
  status               TEXT NOT NULL DEFAULT 'CLASSIFIED',
  routed_to            TEXT,
  related_record_id    TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_manager_intents_context
  ON manager_intents(workspace_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS manager_contexts (
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_intent_class     TEXT,
  last_work_item_id     TEXT REFERENCES work_items(id) ON DELETE SET NULL,
  last_purchase_order_id TEXT REFERENCES purchase_orders(id) ON DELETE SET NULL,
  last_investigation_id TEXT REFERENCES inventory_investigations(id) ON DELETE SET NULL,
  last_entities         TEXT NOT NULL DEFAULT '{}',
  recent_turns          TEXT NOT NULL DEFAULT '[]',
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS manager_briefs (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brief_date       TEXT NOT NULL,
  handled          TEXT NOT NULL DEFAULT '[]',
  handling         TEXT NOT NULL DEFAULT '[]',
  needs_you        TEXT NOT NULL DEFAULT '[]',
  next_events      TEXT NOT NULL DEFAULT '[]',
  summary          TEXT NOT NULL,
  evidence_hash    TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (workspace_id, brief_date)
);

-- A document used to create a brand-new inventory. The interpretation and the
-- original bytes are kept together so the resulting catalogue, order and
-- receipt can always be traced back to what the owner approved.
CREATE TABLE IF NOT EXISTS setup_documents (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  uploaded_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  understanding_id    TEXT REFERENCES foundry_understandings(id) ON DELETE SET NULL,
  source_name         TEXT NOT NULL,
  source_mime         TEXT,
  source_content      BLOB NOT NULL,
  content_hash        TEXT NOT NULL,
  extracted_text      TEXT NOT NULL,
  interpretation      TEXT NOT NULL DEFAULT '{}',
  supplier_code_label TEXT NOT NULL DEFAULT 'Supplier code',
  status              TEXT NOT NULL DEFAULT 'PREPARED'
                        CHECK (status IN ('PREPARED','APPLYING','APPLIED','FAILED')),
  applied_plan_id     TEXT REFERENCES foundry_plans(id) ON DELETE SET NULL,
  purchase_order_id   TEXT REFERENCES purchase_orders(id) ON DELETE SET NULL,
  result              TEXT NOT NULL DEFAULT '{}',
  error_message       TEXT,
  created_at          TEXT NOT NULL,
  applied_at          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_setup_documents_content
  ON setup_documents(workspace_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_setup_documents_understanding
  ON setup_documents(workspace_id, understanding_id);
