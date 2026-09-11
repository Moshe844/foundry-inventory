-- Mission 4: durable production runtime and certification evidence.
--
-- Operational state lives in the same transactional database as the domain
-- records it protects.  A later PostgreSQL adapter may use the same contract;
-- none of the worker semantics below depend on an in-process timer.

CREATE TABLE IF NOT EXISTS runtime_jobs (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  payload           TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','RUNNING','RETRY','COMPLETED','DEAD','CANCELLED')),
  priority          INTEGER NOT NULL DEFAULT 100,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 5,
  available_at      INTEGER NOT NULL,
  lease_owner       TEXT,
  lease_expires_at  INTEGER,
  idempotency_key   TEXT NOT NULL,
  result            TEXT,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  completed_at      TEXT,
  updated_at        TEXT NOT NULL,
  UNIQUE (kind, workspace_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_runtime_jobs_idempotency
  ON runtime_jobs(kind, IFNULL(workspace_id, ''), idempotency_key);
CREATE INDEX IF NOT EXISTS idx_runtime_jobs_claim
  ON runtime_jobs(status, available_at, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_runtime_jobs_lease
  ON runtime_jobs(status, lease_expires_at);

-- Append-only history.  The mutable job row answers "what now?"; this table
-- answers "what happened before the crash/retry/dead-letter?".
CREATE TABLE IF NOT EXISTS runtime_job_events (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES runtime_jobs(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtime_job_events_job
  ON runtime_job_events(job_id, created_at);

CREATE TABLE IF NOT EXISTS runtime_inbox (
  id                 TEXT PRIMARY KEY,
  source             TEXT NOT NULL,
  external_event_id  TEXT NOT NULL,
  payload_hash       TEXT NOT NULL,
  payload            TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'RECEIVED'
                       CHECK (status IN ('RECEIVED','PROCESSING','COMPLETED','FAILED','REJECTED')),
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  outcome            TEXT,
  last_error         TEXT,
  received_at        TEXT NOT NULL,
  processed_at       TEXT,
  UNIQUE (source, external_event_id)
);

CREATE TABLE IF NOT EXISTS runtime_outbox (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  destination       TEXT NOT NULL,
  message_type      TEXT NOT NULL,
  payload           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','RUNNING','RETRY','DELIVERED','DEAD','CANCELLED')),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 8,
  available_at      INTEGER NOT NULL,
  lease_owner       TEXT,
  lease_expires_at  INTEGER,
  idempotency_key   TEXT NOT NULL,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  delivered_at      TEXT,
  updated_at        TEXT NOT NULL,
  UNIQUE (destination, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_runtime_outbox_claim
  ON runtime_outbox(status, available_at, created_at);

CREATE TABLE IF NOT EXISTS operational_alerts (
  id                  TEXT PRIMARY KEY,
  severity            TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','ERROR','CRITICAL')),
  kind                TEXT NOT NULL,
  title               TEXT NOT NULL,
  detail              TEXT NOT NULL,
  fingerprint         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'OPEN'
                        CHECK (status IN ('OPEN','DELIVERED','ACKNOWLEDGED','RESOLVED')),
  occurrence_count    INTEGER NOT NULL DEFAULT 1,
  first_seen_at       TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  delivered_at        TEXT,
  acknowledged_at     TEXT,
  acknowledged_by     TEXT,
  resolved_at         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_alert_active
  ON operational_alerts(fingerprint)
  WHERE status IN ('OPEN','DELIVERED','ACKNOWLEDGED');

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  requested_ip  TEXT,
  expires_at    INTEGER NOT NULL,
  used_at       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_reset_expiry
  ON password_reset_tokens(expires_at, used_at);

CREATE TABLE IF NOT EXISTS production_certification_runs (
  id                TEXT PRIMARY KEY,
  application_ref   TEXT NOT NULL,
  environment       TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('RUNNING','PASSED','FAILED')),
  started_at        TEXT NOT NULL,
  completed_at      TEXT,
  summary           TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS production_certification_checks (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES production_certification_runs(id) ON DELETE CASCADE,
  check_key   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('PASS','FAIL','BLOCKED','SKIPPED')),
  evidence    TEXT NOT NULL DEFAULT '{}',
  checked_at  TEXT NOT NULL,
  UNIQUE (run_id, check_key)
);

CREATE TABLE IF NOT EXISTS runtime_checkpoints (
  check_key   TEXT PRIMARY KEY,
  status      TEXT NOT NULL CHECK (status IN ('PASS','FAIL')),
  detail      TEXT NOT NULL DEFAULT '{}',
  checked_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS database_releases (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  release_ref         TEXT NOT NULL,
  schema_version      INTEGER NOT NULL,
  schema_fingerprint  TEXT NOT NULL,
  applied_at          TEXT NOT NULL,
  UNIQUE (release_ref, schema_fingerprint)
);

-- Browser-visible AI work is durable too. It is kept separate from executable
-- runtime jobs because repeating a paid model call after an unknown crash is a
-- different decision from retrying an idempotent domain command.
CREATE TABLE IF NOT EXISTS foundry_ui_jobs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  track           TEXT NOT NULL,
  subject         TEXT NOT NULL DEFAULT '',
  subject_detail  TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  stage           TEXT NOT NULL,
  timeline        TEXT NOT NULL DEFAULT '{}',
  result          TEXT,
  error           TEXT,
  started_at      INTEGER NOT NULL,
  deadline_at     INTEGER NOT NULL,
  finished_at     INTEGER,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_foundry_ui_jobs_workspace
  ON foundry_ui_jobs(workspace_id, created_at DESC);
