-- Mission 9: governed accounting synchronization and public integration surface.
-- External systems never own physical inventory balances. Accounting writes are
-- staged behind a declared direction and a successful shadow reconciliation.

CREATE TABLE IF NOT EXISTS accounting_sync_policies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL,
  operational_source TEXT NOT NULL DEFAULT 'FOUNDRY'
    CHECK (operational_source = 'FOUNDRY'),
  accounting_source TEXT NOT NULL DEFAULT 'FOUNDRY'
    CHECK (accounting_source IN ('FOUNDRY','EXTERNAL')),
  posting_direction TEXT NOT NULL DEFAULT 'READ_ONLY'
    CHECK (posting_direction IN ('READ_ONLY','FOUNDRY_TO_EXTERNAL','EXTERNAL_TO_FOUNDRY')),
  requested_authority TEXT NOT NULL DEFAULT 'OBSERVE'
    CHECK (requested_authority IN ('OBSERVE','SHADOW','POST')),
  stage TEXT NOT NULL DEFAULT 'READ_ONLY_VERIFIED'
    CHECK (stage IN ('READ_ONLY_VERIFIED','SHADOW','WRITE_READY','WRITE_ENABLED','PAUSED','CONFLICT')),
  verified_fact TEXT NOT NULL DEFAULT '{}',
  verified_at TEXT,
  last_shadow_run_id TEXT,
  write_enabled_by_user_id TEXT REFERENCES users(id),
  write_enabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, connector_id),
  CHECK (posting_direction <> 'FOUNDRY_TO_EXTERNAL' OR accounting_source = 'FOUNDRY'),
  CHECK (posting_direction <> 'EXTERNAL_TO_FOUNDRY' OR accounting_source = 'EXTERNAL')
);

CREATE TABLE IF NOT EXISTS accounting_external_identities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  foundry_record_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_version TEXT,
  payload_hash TEXT,
  last_direction TEXT NOT NULL CHECK (last_direction IN ('READ','WRITE')),
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, connector_id, entity_type, foundry_record_id),
  UNIQUE (workspace_id, connector_id, entity_type, external_id)
);

CREATE TABLE IF NOT EXISTS accounting_posting_account_mappings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  foundry_account_id TEXT NOT NULL REFERENCES accounting_accounts(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  approved_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, connector_id, foundry_account_id)
);
CREATE INDEX IF NOT EXISTS idx_accounting_posting_mappings_external
  ON accounting_posting_account_mappings(workspace_id, connector_id, external_id);

CREATE TABLE IF NOT EXISTS accounting_sync_checkpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  stream TEXT NOT NULL,
  cursor TEXT,
  external_version TEXT,
  watermark_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, connector_id, stream)
);

CREATE TABLE IF NOT EXISTS accounting_shadow_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','MATCHED','MISMATCH','FAILED')),
  as_of TEXT NOT NULL,
  local_snapshot TEXT NOT NULL,
  external_snapshot TEXT NOT NULL,
  differences TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_accounting_shadow_recent
  ON accounting_shadow_runs(workspace_id, connector_id, started_at DESC);

CREATE TABLE IF NOT EXISTS accounting_sync_conflicts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  conflict_key TEXT NOT NULL,
  conflict_type TEXT NOT NULL,
  entity_type TEXT,
  foundry_record_id TEXT,
  external_id TEXT,
  foundry_version TEXT,
  external_version TEXT,
  foundry_payload TEXT NOT NULL DEFAULT '{}',
  external_payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','IGNORED')),
  resolution TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (workspace_id, connector_id, conflict_key)
);
CREATE INDEX IF NOT EXISTS idx_accounting_sync_conflicts_open
  ON accounting_sync_conflicts(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public_api_clients (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS public_api_commands (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES public_api_clients(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  command_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (client_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS outbound_webhook_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  endpoint_url TEXT NOT NULL,
  event_types TEXT NOT NULL DEFAULT '[]',
  signing_secret_hash TEXT NOT NULL,
  signing_secret_encrypted TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','REVOKED')),
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS outbound_webhook_deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES outbound_webhook_subscriptions(id) ON DELETE CASCADE,
  domain_event_id TEXT NOT NULL REFERENCES domain_events(id) ON DELETE CASCADE,
  outbox_message_id TEXT REFERENCES runtime_outbox(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','FAILED','DEAD')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE (subscription_id, domain_event_id)
);
