-- Foundry Inventory : operational autopilot (Mission 7)
--
-- Everything before this mission made Foundry able to do inventory work when a
-- person asked. This is where it starts doing the routine work itself and
-- bringing only the exceptions back — which means the interesting tables here
-- are not the ones that let it act, but the ones that constrain it.
--
-- Three ideas run through the whole schema:
--
--   A policy is data, not a prompt. What Foundry may do automatically is a
--   structured, versioned, customer-approved record. A model may help write
--   one; nothing a model says at run time can authorise an action.
--
--   Work is a durable record, not a screen. Every task Foundry plans has a row
--   with a lifecycle, so a restart mid-execution reconciles rather than repeats,
--   and "what did you do today" is answered from what actually happened.
--
--   Autonomy is revocable and self-limiting. Modes, pauses, daily budgets,
--   cooldowns and an automatic suspension on verification failure are all
--   first-class, because the failure mode of an autonomous system is not one
--   bad action — it is the same bad action a hundred times.

-- ---------------------------------------------------------------------------
-- What Foundry is allowed to do, in this workspace, right now
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workspace_autopilot (
  workspace_id       TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,

  -- OBSERVE          watch, detect, explain, recommend. No mutations.
  -- SUPERVISED       plan and prepare work, execute what a person approves.
  -- POLICY_AUTOMATED execute only what an approved policy explicitly allows.
  mode               TEXT NOT NULL DEFAULT 'SUPERVISED'
                       CHECK (mode IN ('OBSERVE', 'SUPERVISED', 'POLICY_AUTOMATED')),

  -- A person pressing stop. Nothing autonomous runs while this is set;
  -- read-only intelligence continues, and people can still work by hand.
  paused             INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  paused_at          TEXT,
  paused_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  paused_reason      TEXT,

  -- Foundry stopping itself. Separate from a person's pause on purpose: the
  -- two have different causes, different messages, and different ways back.
  suspended          INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
  suspended_at       TEXT,
  suspended_scope    TEXT,          -- e.g. 'transfer' — narrower than the whole workspace
  suspended_reason   TEXT,

  last_evaluated_at  TEXT,
  next_evaluation_at TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- Deterministic operational limits. Deliberately per-workspace rather than
-- global: a business moving forty units a day and one moving four thousand do
-- not share a sensible ceiling.
CREATE TABLE IF NOT EXISTS autopilot_limits (
  workspace_id            TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  max_actions_per_day     INTEGER NOT NULL DEFAULT 20,
  max_units_per_action    INTEGER NOT NULL DEFAULT 50,
  max_value_per_action    REAL,
  max_value_per_day       REAL,
  max_retries             INTEGER NOT NULL DEFAULT 2,
  -- How long the same product must be left alone after an automatic action.
  -- This is what stops stock bouncing between two warehouses because a signal
  -- moved a unit either side of a threshold.
  cooldown_hours          INTEGER NOT NULL DEFAULT 24,
  max_actions_per_item_per_week INTEGER NOT NULL DEFAULT 2,
  updated_at              TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

-- What Foundry may do without asking, expressed as data a person approved.
--
-- Versioned and never edited in place: broadening what an automaton may do is
-- exactly the change that must never happen quietly, so a change supersedes
-- the old version and requires approval again.
CREATE TABLE IF NOT EXISTS automation_policies (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  name                 TEXT NOT NULL,
  description          TEXT,
  enabled              INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),

  -- Only ever a list Foundry's own code understands. A policy naming an action
  -- type that does not exist authorises nothing.
  allowed_action_types TEXT NOT NULL DEFAULT '[]',

  -- What it applies to. An empty scope means "everything of that kind", which
  -- is why every scope is shown in full on the approval screen.
  scope                TEXT NOT NULL DEFAULT '{}',
  item_scope           TEXT NOT NULL DEFAULT '[]',
  location_scope       TEXT NOT NULL DEFAULT '[]',
  supplier_scope       TEXT NOT NULL DEFAULT '[]',
  exclusions           TEXT NOT NULL DEFAULT '[]',

  conditions           TEXT NOT NULL DEFAULT '[]',
  thresholds           TEXT NOT NULL DEFAULT '{}',
  maximum_quantity     INTEGER,
  maximum_value        REAL,
  daily_limit          INTEGER,
  approval_rules       TEXT NOT NULL DEFAULT '{}',

  effective_from       TEXT,
  effective_until      TEXT,

  version              INTEGER NOT NULL DEFAULT 1,
  supersedes_policy_id TEXT REFERENCES automation_policies(id) ON DELETE SET NULL,
  integrity_hash       TEXT NOT NULL DEFAULT '',

  created_by_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_user_id  TEXT REFERENCES users(id) ON DELETE RESTRICT,
  approved_at          TEXT,
  disabled_at          TEXT,
  disabled_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automation_policies_workspace
  ON automation_policies(workspace_id, enabled, name);

-- Every time a policy was consulted, and what it said. This is the audit trail
-- that makes "why did you move those tights" answerable in terms of the rule
-- that allowed it rather than in terms of a model's opinion.
CREATE TABLE IF NOT EXISTS policy_evaluations (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  policy_id          TEXT REFERENCES automation_policies(id) ON DELETE SET NULL,
  work_item_id       TEXT,
  decision           TEXT NOT NULL CHECK (decision IN ('authorized', 'needs_approval', 'refused', 'no_policy')),
  reason             TEXT NOT NULL DEFAULT '',
  checks             TEXT NOT NULL DEFAULT '[]',
  policy_version     INTEGER,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_policy_evaluations_work ON policy_evaluations(work_item_id, created_at);

-- ---------------------------------------------------------------------------
-- Work
-- ---------------------------------------------------------------------------

-- One round of the autopilot loop.
CREATE TABLE IF NOT EXISTS work_plans (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trigger            TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL,
  mode               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'PLANNING'
                       CHECK (status IN ('PLANNING', 'PLANNED', 'EXECUTING', 'COMPLETED', 'FAILED')),
  items_planned      INTEGER NOT NULL DEFAULT 0,
  items_executed     INTEGER NOT NULL DEFAULT 0,
  items_awaiting     INTEGER NOT NULL DEFAULT 0,
  summary            TEXT NOT NULL DEFAULT '{}',
  started_at         TEXT NOT NULL,
  finished_at        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_plans_key ON work_plans(workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_work_plans_workspace ON work_plans(workspace_id, started_at DESC);

-- One piece of inventory work Foundry decided should happen.
--
-- The lifecycle lives here rather than in a screen, which is what makes a
-- restart mid-flight recoverable: an item found in EXECUTING is reconciled
-- against the ledger before anything is retried.
CREATE TABLE IF NOT EXISTS work_items (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_plan_id          TEXT REFERENCES work_plans(id) ON DELETE SET NULL,

  -- The supported category vocabulary lives in work-items.js. Keeping a second
  -- enum here made every new manager capability a destructive table migration.
  category              TEXT NOT NULL,
  source                TEXT NOT NULL,
  source_evidence       TEXT NOT NULL DEFAULT '[]',
  affected_entities     TEXT NOT NULL DEFAULT '{}',
  recommended_action    TEXT NOT NULL DEFAULT '{}',

  priority              REAL NOT NULL DEFAULT 0,
  urgency               TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('immediate', 'soon', 'normal', 'whenever')),
  confidence            TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low')),

  policy_id             TEXT REFERENCES automation_policies(id) ON DELETE SET NULL,
  policy_evaluation     TEXT NOT NULL DEFAULT '{}',
  approval_requirement  TEXT NOT NULL DEFAULT 'REQUIRED'
                          CHECK (approval_requirement IN ('NONE', 'REQUIRED', 'REQUIRED_WITH_WARNING')),

  -- The list of states work can be in lives in application code, which is the
  -- only place it can be kept honest as new ones are added.
  execution_status      TEXT NOT NULL DEFAULT 'DETECTED',
  verification_status   TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (verification_status IN ('PENDING', 'VERIFIED', 'FAILED', 'NOT_APPLICABLE')),

  -- What it became: the Mission 4 proposal, the PO, the movements.
  proposal_id           TEXT,
  purchase_order_id     TEXT,
  movement_ids          TEXT NOT NULL DEFAULT '[]',
  idempotency_key       TEXT NOT NULL,

  outcome               TEXT NOT NULL DEFAULT '{}',
  error_message         TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,

  approved_by_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at           TEXT,
  created_at            TEXT NOT NULL,
  due_at                TEXT,
  completed_at          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_items_key ON work_items(workspace_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_work_items_workspace ON work_items(workspace_id, execution_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_items_plan ON work_items(work_plan_id);

-- The story of one work item, in order.
CREATE TABLE IF NOT EXISTS work_item_events (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_item_id   TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  event          TEXT NOT NULL,
  detail         TEXT NOT NULL DEFAULT '{}',
  actor_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_item_events ON work_item_events(work_item_id, created_at);

-- ---------------------------------------------------------------------------
-- Telling the customer
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notifications (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('approval_required', 'action_completed', 'action_failed', 'paused',
                    'exception', 'purchase_prepared')),
  severity       TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'important', 'critical')),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  work_item_id   TEXT REFERENCES work_items(id) ON DELETE CASCADE,
  link           TEXT,
  read_at        TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_workspace ON notifications(workspace_id, read_at, created_at DESC);

-- Durable operating preferences, stated explicitly and never inferred.
--
-- A model must not quietly conclude that this business prefers transfers over
-- purchases and start acting on it. Everything here came from an instruction, an
-- approved policy or a configuration a person confirmed, and records which.
CREATE TABLE IF NOT EXISTS operational_preferences (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key            TEXT NOT NULL,
  value          TEXT NOT NULL,
  stated_as      TEXT,
  source         TEXT NOT NULL CHECK (source IN ('instruction', 'policy', 'configuration')),
  set_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_preferences ON operational_preferences(workspace_id, key);

-- ---------------------------------------------------------------------------
-- Running the loop
-- ---------------------------------------------------------------------------

-- Only one process may run the autopilot loop at a time. Two servers against
-- one database would otherwise both plan and both execute; the work item's
-- idempotency key would catch the duplicate, but racing to find that out is a
-- bet rather than a design.
CREATE TABLE IF NOT EXISTS autopilot_lease (
  id          TEXT PRIMARY KEY,        -- always 'autopilot'
  holder      TEXT NOT NULL,           -- which process holds it
  expires_at  INTEGER NOT NULL,        -- epoch ms
  acquired_at TEXT NOT NULL
);
