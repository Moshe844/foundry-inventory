-- Mission 10: one durable autonomous-operation contract across every domain.

CREATE TABLE IF NOT EXISTS autonomous_operations (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_type        TEXT NOT NULL,
  domain                TEXT NOT NULL,
  source_kind           TEXT,
  source_id             TEXT,
  idempotency_key       TEXT NOT NULL,
  phase                 TEXT NOT NULL CHECK (phase IN
                           ('OBSERVE','UNDERSTAND','REASON','COMPARE','DECIDE','AUTHORIZE',
                            'EXECUTE','VERIFY','RECOVER','COMPENSATE','LEARN','ESCALATE','DONE')),
  status                TEXT NOT NULL CHECK (status IN
                           ('PLANNED','WAITING_FOR_AUTHORITY','AUTHORIZED','RUNNING','VERIFYING',
                            'RECOVERING','COMPENSATING','COMPLETED','NEEDS_HUMAN','FAILED','CANCELLED')),
  automatic             INTEGER NOT NULL DEFAULT 0 CHECK (automatic IN (0,1)),
  title                 TEXT NOT NULL,
  summary               TEXT,
  link                  TEXT,
  evidence              TEXT NOT NULL DEFAULT '[]',
  understanding         TEXT NOT NULL DEFAULT '{}',
  reasoning             TEXT NOT NULL DEFAULT '{}',
  alternatives          TEXT NOT NULL DEFAULT '[]',
  decision              TEXT NOT NULL DEFAULT '{}',
  affected_entities     TEXT NOT NULL DEFAULT '{}',
  authority_dimensions  TEXT NOT NULL DEFAULT '{}',
  authority_snapshot    TEXT NOT NULL DEFAULT '{}',
  expected_outcome      TEXT NOT NULL DEFAULT '{}',
  actual_outcome        TEXT NOT NULL DEFAULT '{}',
  verification          TEXT NOT NULL DEFAULT '{}',
  recovery              TEXT NOT NULL DEFAULT '{}',
  learning              TEXT NOT NULL DEFAULT '{}',
  error_message         TEXT,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  created_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL,
  authorized_at         TEXT,
  started_at            TEXT,
  completed_at          TEXT,
  updated_at            TEXT NOT NULL,
  UNIQUE (workspace_id, operation_type, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_autonomous_operations_status
  ON autonomous_operations(workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_autonomous_operations_source
  ON autonomous_operations(workspace_id, source_kind, source_id);

CREATE TABLE IF NOT EXISTS autonomous_operation_events (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id    TEXT NOT NULL REFERENCES autonomous_operations(id) ON DELETE CASCADE,
  phase           TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  detail          TEXT NOT NULL DEFAULT '{}',
  actor_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_autonomous_operation_events
  ON autonomous_operation_events(operation_id, created_at, id);
CREATE TRIGGER IF NOT EXISTS autonomous_operation_events_immutable_update
BEFORE UPDATE ON autonomous_operation_events BEGIN
  SELECT RAISE(ABORT, 'autonomous operation events are immutable');
END;
CREATE TRIGGER IF NOT EXISTS autonomous_operation_events_immutable_delete
BEFORE DELETE ON autonomous_operation_events BEGIN
  SELECT RAISE(ABORT, 'autonomous operation events are immutable');
END;

-- Grants are immutable versions. Replacing or revoking one disables the prior
-- row, so the exact authority consulted by an operation remains auditable.
CREATE TABLE IF NOT EXISTS autonomous_operation_authority (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_type        TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  maximum_quantity      REAL,
  maximum_value_minor   INTEGER,
  maximum_daily_count   INTEGER,
  maximum_daily_value_minor INTEGER,
  supplier_ids          TEXT NOT NULL DEFAULT '[]',
  customer_ids          TEXT NOT NULL DEFAULT '[]',
  location_ids          TEXT NOT NULL DEFAULT '[]',
  allowed_roles         TEXT NOT NULL DEFAULT '[]',
  minimum_confidence    TEXT CHECK (minimum_confidence IN ('low','medium','high')),
  maximum_risk          TEXT CHECK (maximum_risk IN ('low','medium','high','critical')),
  allowed_time_windows  TEXT NOT NULL DEFAULT '[]',
  version               INTEGER NOT NULL DEFAULT 1,
  supersedes_id         TEXT REFERENCES autonomous_operation_authority(id) ON DELETE SET NULL,
  granted_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  granted_at            TEXT,
  revoked_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at            TEXT,
  created_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_autonomous_operation_authority_active
  ON autonomous_operation_authority(workspace_id, operation_type)
  WHERE enabled = 1 AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS autonomous_operation_interventions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id    TEXT NOT NULL REFERENCES autonomous_operations(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN
                    ('AUTHORITY_REQUIRED','JUDGEMENT_REQUIRED','VERIFICATION_FAILED',
                     'RECOVERY_REQUIRED','OWNER_CHANGED_OUTCOME')),
  reason          TEXT NOT NULL,
  resolution      TEXT,
  resolved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_autonomous_operation_interventions_open
  ON autonomous_operation_interventions(workspace_id, resolved_at, created_at DESC);
