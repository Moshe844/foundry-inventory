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

-- Mission 9: the durable business events that wake the manager.
--
-- This is deliberately not an inventory ledger. The immutable movement and PO
-- records remain the truth; this table records that a committed fact needs a
-- reaction, so a crash between the fact and the reaction can be recovered
-- without repeating either one. One workspace plus one idempotency key is one
-- event, however often a connector, browser, or worker retries it.
CREATE TABLE IF NOT EXISTS domain_events (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type         TEXT NOT NULL,
  payload            TEXT NOT NULL DEFAULT '{}',
  source             TEXT NOT NULL DEFAULT 'foundry',
  source_record_type TEXT,
  source_record_id   TEXT,
  idempotency_key    TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING','PROCESSING','PROCESSED','FAILED')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  result             TEXT NOT NULL DEFAULT '{}',
  error_message      TEXT,
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  processed_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_domain_events_key
  ON domain_events(workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_domain_events_pending
  ON domain_events(status, created_at);
CREATE INDEX IF NOT EXISTS idx_domain_events_workspace
  ON domain_events(workspace_id, created_at DESC);

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

-- A durable, reviewable interpretation of an owner's operating instruction.
-- The model only fills the typed `changes` document. Real record ids are
-- resolved by application code, and nothing is applied until the owner
-- approves this exact snapshot.
CREATE TABLE IF NOT EXISTS operating_instruction_proposals (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  stated_as           TEXT NOT NULL,
  source              TEXT NOT NULL DEFAULT 'owner_instruction',
  summary             TEXT NOT NULL,
  changes             TEXT NOT NULL DEFAULT '[]',
  resolved_changes    TEXT NOT NULL DEFAULT '[]',
  questions           TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','APPROVED','CANCELLED','SUPERSEDED','REMOVED')),
  integrity_hash      TEXT NOT NULL,
  applied_records     TEXT NOT NULL DEFAULT '[]',
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at         TEXT,
  removed_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  removed_at          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operating_instructions_workspace
  ON operating_instruction_proposals(workspace_id, status, created_at DESC);

-- Deterministic stock-protection rules taught through either conversation or
-- Settings. These are enforced by the inventory engine itself, so an issue
-- cannot bypass them by arriving through a different screen or connector.
CREATE TABLE IF NOT EXISTS operating_guards (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id              TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  location_id         TEXT REFERENCES locations(id) ON DELETE CASCADE,
  action_type         TEXT NOT NULL CHECK (action_type IN ('issue')),
  enforcement_mode    TEXT NOT NULL DEFAULT 'block' CHECK (enforcement_mode IN ('block','warn')),
  metric              TEXT NOT NULL CHECK (metric IN ('network_on_hand','location_on_hand')),
  comparator          TEXT NOT NULL CHECK (comparator IN ('below','at_or_below')),
  threshold           INTEGER NOT NULL CHECK (threshold >= 0),
  release_condition   TEXT NOT NULL CHECK (release_condition IN ('on_order','stock_recovered','manual')),
  release_threshold   INTEGER CHECK (release_threshold IS NULL OR release_threshold >= 0),
  source              TEXT NOT NULL DEFAULT 'settings',
  stated_as           TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operating_guards_scope
  ON operating_guards(workspace_id, sku_id, location_id, action_type, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS uq_operating_guards_active_scope
  ON operating_guards(workspace_id, sku_id, IFNULL(location_id, ''), action_type)
  WHERE is_active = 1;

-- Supplier communication is deliberately an outbox. Preparing or queuing a
-- message is not the same as sending one. A future transport adapter may mark
-- it SENT only after the external provider confirms delivery.
CREATE TABLE IF NOT EXISTS supplier_communications (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id         TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  purchase_order_id   TEXT REFERENCES purchase_orders(id) ON DELETE SET NULL,
  channel             TEXT NOT NULL DEFAULT 'email',
  recipient           TEXT,
  subject             TEXT NOT NULL,
  body                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'PREPARED'
                        CHECK (status IN ('PREPARED','QUEUED','SENDING','SENT','FAILED','CANCELLED')),
  transport           TEXT,
  external_message_id TEXT,
  message_kind        TEXT NOT NULL DEFAULT 'purchase_order',
  connector_id        TEXT,
  external_thread_id  TEXT,
  approved_by_user_id TEXT,
  approved_at         TEXT,
  idempotency_key     TEXT NOT NULL,
  error_message       TEXT,
  created_at          TEXT NOT NULL,
  queued_at           TEXT,
  sent_at             TEXT,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_communications_key
  ON supplier_communications(workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_supplier_communications_po
  ON supplier_communications(workspace_id, purchase_order_id, created_at DESC);

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
  scope_confirmed_at  TEXT,
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

-- A request to undo records created by an earlier document. The proposal is
-- durable because removing stock is consequential: the exact products and
-- balances shown to the owner must be the ones acted on after approval.
CREATE TABLE IF NOT EXISTS document_removal_proposals (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  setup_document_id     TEXT NOT NULL REFERENCES setup_documents(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_document_removals_workspace
  ON document_removal_proposals(workspace_id, created_at DESC);

-- Controlled catalogue code transformations prepared from Tell Foundry.
-- External supplier codes are deliberately excluded: these are the owner's
-- internal item/SKU identifiers, shown old -> new before one atomic approval.
CREATE TABLE IF NOT EXISTS catalog_code_change_proposals (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_user_id   TEXT REFERENCES users(id) ON DELETE RESTRICT,
  instruction           TEXT NOT NULL,
  operation             TEXT NOT NULL DEFAULT '{}',
  snapshot              TEXT NOT NULL DEFAULT '{}',
  integrity_hash        TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','COMPLETED','CANCELLED')),
  result                TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL,
  completed_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_catalog_code_changes_workspace
  ON catalog_code_change_proposals(workspace_id, created_at DESC);
