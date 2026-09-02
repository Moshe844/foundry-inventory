-- Mission 11: external connections and trustworthy event ingestion.
-- Provider payloads are evidence. Only Foundry's existing domain services may
-- create inventory movements, commitments, or purchasing records.

CREATE TABLE IF NOT EXISTS connection_mappings (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id        TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  entity_type         TEXT NOT NULL CHECK (entity_type IN ('sku','location','customer','sales_order','supplier')),
  external_id         TEXT NOT NULL,
  foundry_record_id   TEXT NOT NULL,
  confidence          TEXT NOT NULL DEFAULT 'approved' CHECK (confidence IN ('exact','approved')),
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (workspace_id, connector_id, entity_type, external_id)
);
CREATE INDEX IF NOT EXISTS idx_connection_mappings_foundry
  ON connection_mappings(workspace_id, entity_type, foundry_record_id);

CREATE TABLE IF NOT EXISTS connection_issues (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id        TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  external_event_id   TEXT,
  issue_type          TEXT NOT NULL,
  fingerprint         TEXT NOT NULL,
  title               TEXT NOT NULL,
  detail              TEXT NOT NULL,
  resolution_hint     TEXT NOT NULL,
  candidate_matches   TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','DISMISSED')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  resolved_at         TEXT,
  UNIQUE (workspace_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_connection_issues_open
  ON connection_issues(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS connection_reconciliations (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id        TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  period_start        TEXT,
  period_end          TEXT,
  expected            TEXT NOT NULL DEFAULT '{}',
  observed            TEXT NOT NULL DEFAULT '{}',
  discrepancies       TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL CHECK (status IN ('MATCHED','MISMATCH')),
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connection_reconciliations_connection
  ON connection_reconciliations(workspace_id, connector_id, created_at DESC);

CREATE TABLE IF NOT EXISTS connection_email_rules (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id        TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  sender_pattern      TEXT NOT NULL,
  supplier_id         TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  document_mode       TEXT NOT NULL DEFAULT 'review_each'
                      CHECK (document_mode IN ('review_each','supplier_documents','inventory_list')),
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          TEXT NOT NULL,
  UNIQUE (workspace_id, connector_id, sender_pattern COLLATE NOCASE)
);

CREATE TABLE IF NOT EXISTS connection_email_messages (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id        TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  external_message_id TEXT NOT NULL,
  sender              TEXT NOT NULL,
  recipients          TEXT NOT NULL DEFAULT '[]',
  subject             TEXT,
  body_text           TEXT,
  received_at         TEXT NOT NULL,
  supplier_id         TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  trust_status        TEXT NOT NULL CHECK (trust_status IN ('TRUSTED','UNTRUSTED')),
  classification      TEXT NOT NULL DEFAULT 'unclassified',
  external_thread_id  TEXT,
  internet_message_id TEXT,
  content_hash        TEXT,
  processing_status   TEXT NOT NULL DEFAULT 'CAPTURED',
  processed_at        TEXT,
  -- Whether a person still owes this sender an answer.
  --
  -- Deliberately separate from processing_status, which only ever meant "did
  -- Foundry get a document out of this". A supplier can send an order
  -- acknowledgement that Foundry matches perfectly and that still ends with a
  -- question nobody has answered. One state cannot carry both facts.
  reply_state         TEXT NOT NULL DEFAULT 'HANDLED'
                        CHECK (reply_state IN ('NEEDS_REPLY','WAITING','HANDLED')),
  reply_reason        TEXT,
  reply_state_by_user_id TEXT,
  reply_state_at      TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (workspace_id, connector_id, external_message_id)
);

CREATE TABLE IF NOT EXISTS connection_email_attachments (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id          TEXT NOT NULL REFERENCES connection_email_messages(id) ON DELETE CASCADE,
  external_attachment_id TEXT,
  filename            TEXT NOT NULL,
  mime_type           TEXT,
  content_hash        TEXT NOT NULL,
  content             BLOB,
  extracted_text      TEXT,
  setup_document_id   TEXT REFERENCES setup_documents(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (message_id, content_hash, filename)
);

-- Mission 12: real provider authorization and discovery. Secrets are AES-GCM
-- ciphertext only; provider configuration and rendered pages never contain a
-- usable credential.
CREATE TABLE IF NOT EXISTS connection_credentials (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id        TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  credential_kind     TEXT NOT NULL,
  ciphertext          TEXT NOT NULL,
  iv                   TEXT NOT NULL,
  auth_tag             TEXT NOT NULL,
  expires_at           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (workspace_id, connector_id, credential_kind)
);

CREATE TABLE IF NOT EXISTS connection_authorization_states (
  id                  TEXT PRIMARY KEY,
  state_hash          TEXT NOT NULL UNIQUE,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id        TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  provider_type       TEXT NOT NULL,
  actor_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  metadata             TEXT NOT NULL DEFAULT '{}',
  expires_at           TEXT NOT NULL,
  used_at              TEXT,
  created_at           TEXT NOT NULL
);

-- A safe cache of provider catalog/location records. It contains descriptive
-- evidence only, never provider access tokens or inventory balances.
CREATE TABLE IF NOT EXISTS connection_external_records (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id        TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  entity_type         TEXT NOT NULL CHECK (entity_type IN ('sku','location','customer')),
  external_id         TEXT NOT NULL,
  parent_external_id  TEXT,
  code                 TEXT,
  display_name        TEXT NOT NULL,
  provider_data        TEXT NOT NULL DEFAULT '{}',
  mapping_status      TEXT NOT NULL DEFAULT 'UNMAPPED'
                        CHECK (mapping_status IN ('UNMAPPED','MAPPED','IGNORED')),
  selected             INTEGER NOT NULL DEFAULT 1 CHECK (selected IN (0,1)),
  last_seen_at         TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (workspace_id, connector_id, entity_type, external_id)
);
CREATE INDEX IF NOT EXISTS idx_connection_external_records_mapping
  ON connection_external_records(workspace_id, connector_id, mapping_status, entity_type);

CREATE TABLE IF NOT EXISTS connection_sync_runs (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id        TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  sync_kind           TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  discovered_products INTEGER NOT NULL DEFAULT 0,
  discovered_locations INTEGER NOT NULL DEFAULT 0,
  auto_mapped         INTEGER NOT NULL DEFAULT 0,
  needs_mapping       INTEGER NOT NULL DEFAULT 0,
  error_message       TEXT,
  started_at          TEXT NOT NULL,
  completed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_connection_sync_runs_connection
  ON connection_sync_runs(workspace_id, connector_id, started_at DESC);
