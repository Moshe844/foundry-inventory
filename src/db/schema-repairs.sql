-- Mission 3: governed cross-domain repair cases.
--
-- The case is the resumable state machine. The event stream is append-only
-- evidence of every diagnosis, simulation, authority decision, execution and
-- verification attempt. Operational truth remains owned by its domain.

CREATE TABLE IF NOT EXISTS repair_cases (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL,
  symptom               TEXT NOT NULL,
  failed_invariant      TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'OPEN'
                          CHECK (status IN ('OPEN','DIAGNOSED','SIMULATED','NEEDS_AUTHORITY',
                                            'AUTHORIZED','EXECUTING','VERIFYING','RESOLVED',
                                            'FAILED','INCONCLUSIVE')),
  confidence            TEXT NOT NULL DEFAULT 'low'
                          CHECK (confidence IN ('low','medium','high')),
  materiality           TEXT NOT NULL DEFAULT 'unknown'
                          CHECK (materiality IN ('unknown','low','medium','high')),
  affected_records      TEXT NOT NULL DEFAULT '{}',
  timeline              TEXT NOT NULL DEFAULT '[]',
  evidence              TEXT NOT NULL DEFAULT '[]',
  proposed_repair       TEXT NOT NULL DEFAULT '{}',
  simulation            TEXT NOT NULL DEFAULT '{}',
  before_evidence       TEXT NOT NULL DEFAULT '{}',
  execution_result      TEXT NOT NULL DEFAULT '{}',
  after_evidence        TEXT NOT NULL DEFAULT '{}',
  verification          TEXT NOT NULL DEFAULT '{}',
  adapter_id            TEXT NOT NULL,
  adapter_version       INTEGER NOT NULL DEFAULT 1,
  required_permissions  TEXT NOT NULL DEFAULT '[]',
  requires_approval     INTEGER NOT NULL DEFAULT 0,
  approved_by_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at           TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  checkpoint            TEXT,
  error_message         TEXT,
  idempotency_key       TEXT NOT NULL,
  created_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  resolved_at           TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_repair_cases_key
  ON repair_cases(workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_repair_cases_queue
  ON repair_cases(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS repair_case_events (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repair_case_id     TEXT NOT NULL REFERENCES repair_cases(id) ON DELETE CASCADE,
  event              TEXT NOT NULL,
  detail             TEXT NOT NULL DEFAULT '{}',
  actor_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repair_case_events
  ON repair_case_events(repair_case_id, created_at);

CREATE TRIGGER IF NOT EXISTS repair_case_events_immutable_update
BEFORE UPDATE ON repair_case_events BEGIN
  SELECT RAISE(ABORT, 'repair case events are immutable');
END;
