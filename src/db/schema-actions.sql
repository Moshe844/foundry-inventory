-- Foundry Inventory : controlled actions (Mission 4)
--
-- Foundry may now carry out inventory work, but only ever by proposing it here
-- and having a person approve it. Nothing in this file mutates stock: every row
-- is a *request* to run one of the Mission 1 operations, plus the evidence that
-- it was authorised, what it expected, what actually happened, and whether the
-- result was verified afterwards.
--
-- The engine remains the only code that changes a balance. These tables record
-- intent and outcome around it.

-- A single proposed operation. Immutable once approved: a changed quantity
-- supersedes the proposal rather than editing it, so what a person approved is
-- always exactly what is on record.
CREATE TABLE IF NOT EXISTS action_proposals (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id                  TEXT,                    -- set when part of a multi-line plan
  line_number              INTEGER NOT NULL DEFAULT 1,

  requested_by_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_user_id      TEXT REFERENCES users(id) ON DELETE RESTRICT,

  source_type              TEXT NOT NULL CHECK (source_type IN
                             ('USER_REQUEST', 'FOUNDRY_RECOMMENDATION', 'ATTENTION_ITEM', 'COMPENSATION')),
  source_attention_id      TEXT REFERENCES attention_items(id) ON DELETE SET NULL,
  source_proposal_id       TEXT,                    -- what this supersedes or compensates
  original_instruction     TEXT,

  -- Deliberately not a CHECK list: the set of action types is enumerated in
  -- src/actions/policy.js, and duplicating it here means a schema migration
  -- every time one is added — a list that goes stale and blocks the code that
  -- already validates it.
  action_type              TEXT NOT NULL,

  -- What the action is about. Every id below is resolved deterministically and
  -- verified to belong to this workspace before the proposal is stored.
  item_id                  TEXT REFERENCES items(id) ON DELETE CASCADE,
  sku_id                   TEXT REFERENCES skus(id) ON DELETE CASCADE,
  serial_unit_ids          TEXT NOT NULL DEFAULT '[]',
  lot_id                   TEXT REFERENCES lots(id) ON DELETE SET NULL,
  source_location_id       TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  destination_location_id  TEXT REFERENCES locations(id) ON DELETE RESTRICT,

  quantity                 INTEGER,
  adjustment_target        INTEGER,
  reason_code              TEXT,
  notes                    TEXT,
  settings                 TEXT NOT NULL DEFAULT '{}',  -- configuration actions

  expected_before_state    TEXT NOT NULL DEFAULT '{}',
  expected_after_state     TEXT NOT NULL DEFAULT '{}',
  assumptions              TEXT NOT NULL DEFAULT '[]',
  warnings                 TEXT NOT NULL DEFAULT '[]',

  safety_level             TEXT NOT NULL CHECK (safety_level IN ('LOW', 'MUTATION', 'HIGH')),
  approval_requirement     TEXT NOT NULL CHECK (approval_requirement IN
                             ('NONE', 'CONFIRM', 'CONFIRM_WITH_WARNING')),
  required_permission      TEXT NOT NULL,

  validation_status        TEXT NOT NULL CHECK (validation_status IN ('VALID', 'INVALID', 'NEEDS_INPUT')),
  validation_problems      TEXT NOT NULL DEFAULT '[]',
  clarifying_question      TEXT,

  status                   TEXT NOT NULL CHECK (status IN
                             ('DRAFT', 'VALIDATED', 'AWAITING_APPROVAL', 'APPROVED',
                              'EXECUTING', 'SUCCEEDED', 'FAILED', 'INVALIDATED',
                              'CANCELLED', 'SUPERSEDED')),

  proposal_version         INTEGER NOT NULL DEFAULT 1,
  integrity_hash           TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  expires_at               TEXT NOT NULL,
  approved_at              TEXT,
  completed_at             TEXT
);
CREATE INDEX IF NOT EXISTS idx_action_proposals_workspace ON action_proposals(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_proposals_plan ON action_proposals(plan_id, line_number);
CREATE INDEX IF NOT EXISTS idx_action_proposals_attention ON action_proposals(source_attention_id);

-- Several related lines approved and executed together.
CREATE TABLE IF NOT EXISTS action_plans (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_user_id  TEXT REFERENCES users(id) ON DELETE RESTRICT,
  original_instruction TEXT,
  summary              TEXT NOT NULL DEFAULT '',
  -- ALL_OR_NOTHING is the default: a half-done batch is a worse outcome than
  -- none of it, because nobody knows which half ran.
  atomicity_policy     TEXT NOT NULL DEFAULT 'ALL_OR_NOTHING'
                         CHECK (atomicity_policy IN ('ALL_OR_NOTHING', 'INDEPENDENT')),
  status               TEXT NOT NULL CHECK (status IN
                         ('DRAFT', 'VALIDATED', 'AWAITING_APPROVAL', 'APPROVED',
                          'EXECUTING', 'SUCCEEDED', 'FAILED', 'INVALIDATED', 'CANCELLED')),
  created_at           TEXT NOT NULL,
  expires_at           TEXT NOT NULL,
  approved_at          TEXT,
  completed_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_action_plans_workspace ON action_plans(workspace_id, status, created_at DESC);

-- One row per *attempt to execute*, claimed before the engine is called.
-- The unique idempotency key is what makes a double-click, a browser retry or a
-- replayed request return the first result instead of moving stock twice.
CREATE TABLE IF NOT EXISTS action_executions (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key   TEXT NOT NULL,
  proposal_id       TEXT REFERENCES action_proposals(id) ON DELETE CASCADE,
  plan_id           TEXT REFERENCES action_plans(id) ON DELETE CASCADE,
  executed_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status            TEXT NOT NULL CHECK (status IN ('EXECUTING', 'SUCCEEDED', 'FAILED')),
  movement_group_ids TEXT NOT NULL DEFAULT '[]',
  movement_ids      TEXT NOT NULL DEFAULT '[]',
  result            TEXT NOT NULL DEFAULT '{}',
  error_message     TEXT,
  started_at        TEXT NOT NULL,
  finished_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_action_executions_key
  ON action_executions(workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_action_executions_proposal ON action_executions(proposal_id);

-- What the balances actually were afterwards, re-read from Mission 1 truth.
-- Stored separately from the execution so "it ran" and "it was verified" can
-- never be the same claim.
CREATE TABLE IF NOT EXISTS action_verifications (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  execution_id   TEXT NOT NULL REFERENCES action_executions(id) ON DELETE CASCADE,
  proposal_id    TEXT REFERENCES action_proposals(id) ON DELETE CASCADE,
  verified       INTEGER NOT NULL CHECK (verified IN (0, 1)),
  checks         TEXT NOT NULL DEFAULT '[]',
  observed_state TEXT NOT NULL DEFAULT '{}',
  problems       TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_verifications_execution ON action_verifications(execution_id);

-- The lifecycle, in order, so an action's whole story is answerable.
CREATE TABLE IF NOT EXISTS action_events (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  proposal_id   TEXT REFERENCES action_proposals(id) ON DELETE CASCADE,
  plan_id       TEXT REFERENCES action_plans(id) ON DELETE CASCADE,
  event         TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '{}',
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_events_proposal ON action_events(proposal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_action_events_workspace ON action_events(workspace_id, created_at DESC);
