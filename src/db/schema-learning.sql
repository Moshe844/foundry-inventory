-- Mission 13: governed outcome learning.
--
-- This schema stores observations and proposed changes. It is not an
-- inventory ledger, an accounting ledger, or a model configuration file.
-- Deterministic domain adapters remain the only way a promoted proposal can
-- change a real operating policy.

CREATE TABLE IF NOT EXISTS learning_decisions (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_kind           TEXT NOT NULL CHECK (source_kind IN
                          ('FORECAST','INVENTORY_PLAN','AUTONOMOUS_OPERATION','SUPPLIER_RESPONSE',
                           'SUPPLIER_DELIVERY','POLICY_CHANGE')),
  source_id             TEXT NOT NULL,
  decision_kind         TEXT NOT NULL,
  subject_type          TEXT NOT NULL,
  subject_id            TEXT,
  decided_at            TEXT NOT NULL,
  model_id              TEXT,
  model_version         TEXT,
  rule_id               TEXT,
  rule_version          TEXT,
  policy_id             TEXT,
  policy_version        INTEGER,
  evidence              TEXT NOT NULL DEFAULT '{}',
  decision              TEXT NOT NULL DEFAULT '{}',
  expected_outcome      TEXT NOT NULL DEFAULT '{}',
  actual_outcome        TEXT NOT NULL DEFAULT '{}',
  outcome_status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (outcome_status IN
                          ('OPEN','MEASURED','INCONCLUSIVE')),
  measured_at           TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (workspace_id, source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_learning_decisions_outcome
  ON learning_decisions(workspace_id, outcome_status, decided_at DESC);

-- Append-only measurements. A later evaluator can add a better observation;
-- it cannot rewrite what an earlier evaluator measured.
CREATE TABLE IF NOT EXISTS learning_outcome_observations (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  decision_id           TEXT NOT NULL REFERENCES learning_decisions(id) ON DELETE CASCADE,
  metric_name           TEXT NOT NULL CHECK (metric_name IN
                          ('FORECAST_ERROR_UNITS','SUPPLIER_LEAD_TIME_ERROR_DAYS',
                           'STOCKOUT_AVOIDED','EXCESS_INVENTORY_UNITS','EXCESS_INVENTORY_VALUE_MINOR',
                           'CASH_USE_MINOR','MARGIN_IMPACT_MINOR','OWNER_INTERVENTION')),
  predicted_value       REAL,
  actual_value          REAL,
  unit                  TEXT NOT NULL,
  comparable            INTEGER NOT NULL DEFAULT 1 CHECK (comparable IN (0,1)),
  evidence              TEXT NOT NULL DEFAULT '{}',
  evaluator_id          TEXT NOT NULL,
  evaluator_version     TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL,
  observed_at           TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_learning_observations_metric
  ON learning_outcome_observations(workspace_id, metric_name, observed_at DESC);
CREATE TRIGGER IF NOT EXISTS learning_observations_immutable_update
BEFORE UPDATE ON learning_outcome_observations BEGIN
  SELECT RAISE(ABORT, 'learning outcome observations are immutable');
END;
CREATE TRIGGER IF NOT EXISTS learning_observations_immutable_delete
BEFORE DELETE ON learning_outcome_observations BEGIN
  SELECT RAISE(ABORT, 'learning outcome observations are immutable');
END;

CREATE TABLE IF NOT EXISTS learning_proposals (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  improvement_kind      TEXT NOT NULL CHECK (improvement_kind IN
                          ('SUPPLIER_LEAD_TIME','SAFETY_STOCK')),
  target_type           TEXT NOT NULL CHECK (target_type IN ('SUPPLIER','SKU')),
  target_id             TEXT NOT NULL,
  headline              TEXT NOT NULL,
  rationale             TEXT NOT NULL,
  current_value         TEXT NOT NULL DEFAULT '{}',
  proposed_value        TEXT NOT NULL DEFAULT '{}',
  evidence              TEXT NOT NULL DEFAULT '{}',
  expected_impact       TEXT NOT NULL DEFAULT '{}',
  model_id              TEXT,
  model_version         TEXT,
  rule_id               TEXT NOT NULL,
  rule_version          TEXT NOT NULL,
  materiality           TEXT NOT NULL CHECK (materiality IN ('LOW','MEDIUM','HIGH')),
  status                TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN
                          ('PROPOSED','APPROVED','ROLLED_OUT','DECLINED','ROLLBACK_RECOMMENDED',
                           'REVERTED','SUPERSEDED','FAILED')),
  integrity_hash        TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL,
  authority_snapshot    TEXT NOT NULL DEFAULT '{}',
  approved_by_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at           TEXT,
  rolled_out_at         TEXT,
  declined_at           TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_learning_proposals_status
  ON learning_proposals(workspace_id, status, created_at DESC);

-- Explicit, versioned and narrow. No row means Foundry may propose only.
CREATE TABLE IF NOT EXISTS learning_authority (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  improvement_kind      TEXT NOT NULL CHECK (improvement_kind IN
                          ('SUPPLIER_LEAD_TIME','SAFETY_STOCK')),
  enabled               INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  target_ids            TEXT NOT NULL DEFAULT '[]',
  maximum_absolute_change REAL,
  maximum_percent_change REAL,
  maximum_materiality   TEXT NOT NULL DEFAULT 'LOW' CHECK (maximum_materiality IN ('LOW','MEDIUM','HIGH')),
  version               INTEGER NOT NULL DEFAULT 1,
  supersedes_id         TEXT REFERENCES learning_authority(id) ON DELETE SET NULL,
  granted_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  granted_at            TEXT,
  revoked_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at            TEXT,
  created_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_learning_authority_active
  ON learning_authority(workspace_id, improvement_kind)
  WHERE enabled=1 AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS learning_rollouts (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  proposal_id           TEXT NOT NULL REFERENCES learning_proposals(id) ON DELETE RESTRICT,
  adapter_id            TEXT NOT NULL,
  adapter_version       TEXT NOT NULL,
  previous_value        TEXT NOT NULL DEFAULT '{}',
  applied_value         TEXT NOT NULL DEFAULT '{}',
  authority_snapshot    TEXT NOT NULL DEFAULT '{}',
  automatic             INTEGER NOT NULL DEFAULT 0 CHECK (automatic IN (0,1)),
  status                TEXT NOT NULL CHECK (status IN ('ACTIVE','ROLLBACK_RECOMMENDED','REVERTED','FAILED')),
  verification          TEXT NOT NULL DEFAULT '{}',
  applied_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  applied_at            TEXT NOT NULL,
  reverted_by_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  reverted_at           TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_learning_rollout_active
  ON learning_rollouts(workspace_id, proposal_id) WHERE status IN ('ACTIVE','ROLLBACK_RECOMMENDED');

CREATE TABLE IF NOT EXISTS learning_events (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  proposal_id           TEXT REFERENCES learning_proposals(id) ON DELETE CASCADE,
  rollout_id            TEXT REFERENCES learning_rollouts(id) ON DELETE CASCADE,
  event_type            TEXT NOT NULL,
  detail                TEXT NOT NULL DEFAULT '{}',
  actor_user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_events_proposal
  ON learning_events(proposal_id, created_at, id);
CREATE TRIGGER IF NOT EXISTS learning_events_immutable_update
BEFORE UPDATE ON learning_events BEGIN
  SELECT RAISE(ABORT, 'learning events are immutable');
END;
CREATE TRIGGER IF NOT EXISTS learning_events_immutable_delete
BEFORE DELETE ON learning_events BEGIN
  SELECT RAISE(ABORT, 'learning events are immutable');
END;
