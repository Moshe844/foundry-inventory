-- Foundry Inventory : intelligence layer (Mission 2)
--
-- Additive only. No Mission 1 table is altered — the inventory truth engine is
-- untouched by anything in here. Foundry proposes configuration; these tables
-- record what it understood, what it proposed, what the customer decided, and
-- what was actually applied.

-- What Foundry understood from a business description. Immutable once written:
-- a new description produces a new row, so the audit trail is complete.
CREATE TABLE IF NOT EXISTS foundry_understandings (
  id                 TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_description TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  payload            TEXT NOT NULL,           -- validated InventoryUnderstanding, JSON
  confidence         TEXT NOT NULL,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  latency_ms         INTEGER,
  actor_user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_understandings_workspace ON foundry_understandings(workspace_id, created_at DESC);

-- The versioned configuration contract. The customer sees a readable summary;
-- the system uses `payload`. `integrity_hash` covers the payload exactly as
-- approved, so an applied plan can always be proven unmodified.
CREATE TABLE IF NOT EXISTS foundry_plans (
  id                TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  understanding_id  TEXT REFERENCES foundry_understandings(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL DEFAULT 'initial' CHECK (kind IN ('initial', 'change')),
  status            TEXT NOT NULL CHECK (status IN ('proposed', 'applied', 'superseded', 'discarded')),
  configuration_version INTEGER NOT NULL,
  payload           TEXT NOT NULL,            -- validated InventoryConfigurationPlan, JSON
  integrity_hash    TEXT NOT NULL,
  applied_summary   TEXT,                     -- what actually happened, JSON
  actor_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        TEXT NOT NULL,
  applied_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_plans_workspace ON foundry_plans(workspace_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_version ON foundry_plans(workspace_id, configuration_version);

-- Who decided what, and whether the customer or Foundry made the call.
CREATE TABLE IF NOT EXISTS foundry_decisions (
  id           TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id      TEXT NOT NULL REFERENCES foundry_plans(id) ON DELETE CASCADE,
  question_id  TEXT NOT NULL,
  question     TEXT NOT NULL,
  answer_id    TEXT NOT NULL,
  answer_label TEXT NOT NULL,
  decided_by   TEXT NOT NULL CHECK (decided_by IN ('customer', 'foundry')),
  free_text    TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (plan_id, question_id)
);

-- Recommendations are generated per business, kept, and can be accepted.
CREATE TABLE IF NOT EXISTS foundry_recommendations (
  id               TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  understanding_id TEXT REFERENCES foundry_understandings(id) ON DELETE CASCADE,
  plan_id          TEXT REFERENCES foundry_plans(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  noticed          TEXT NOT NULL,
  recommendation   TEXT NOT NULL,
  why_it_matters   TEXT NOT NULL,
  scope            TEXT NOT NULL CHECK (scope IN ('configuration', 'future')),
  confidence       TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  status           TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'accepted', 'declined')),
  position         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recommendations_workspace ON foundry_recommendations(workspace_id, created_at DESC);

-- The workspace's live configuration. One row per workspace.
-- Terminology is presentation only: the domain never reads it.
CREATE TABLE IF NOT EXISTS workspace_configuration (
  workspace_id                TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  configured_at         TEXT,
  configuration_version INTEGER NOT NULL DEFAULT 0,
  applied_plan_id       TEXT REFERENCES foundry_plans(id) ON DELETE SET NULL,
  terminology           TEXT NOT NULL DEFAULT '{}',
  operational_defaults  TEXT NOT NULL DEFAULT '{}',
  inventory_model       TEXT NOT NULL DEFAULT '{}',
  updated_at            TEXT NOT NULL
);

-- Foundry stays available after onboarding; answers are grounded in the
-- workspace's real configuration, and the exchange is kept.
CREATE TABLE IF NOT EXISTS foundry_messages (
  id            TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('user', 'foundry')),
  body          TEXT NOT NULL,
  grounding     TEXT,                          -- what configuration the answer used, JSON
  action_kind   TEXT,                          -- e.g. 'explain', 'change_proposed', 'unsupported'
  plan_id       TEXT REFERENCES foundry_plans(id) ON DELETE SET NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_foundry_messages_workspace ON foundry_messages(workspace_id, created_at);
