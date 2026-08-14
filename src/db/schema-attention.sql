-- Foundry Inventory : attention layer (Mission 3)
--
-- Additive only. Mission 1 owns inventory truth and Mission 2 owns
-- configuration; nothing here is an alternative source of either. Every row
-- below is an *interpretation* of movements and balances that already exist,
-- and can be recomputed from them at any time.

-- One row per distinct operational condition. `fingerprint` is what makes a
-- condition the same condition across evaluations, so first_detected_at,
-- acknowledgement and dismissal survive re-runs instead of churning.
CREATE TABLE IF NOT EXISTS attention_items (
  id                    TEXT PRIMARY KEY,
  workspace_id                TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fingerprint           TEXT NOT NULL,
  -- Deliberately not a CHECK list: the categories are enumerated in
  -- src/attention/policy.js, which is also what decides which ones a given
  -- workspace can produce. Duplicating them here means a schema migration every
  -- time one is added — a list that goes stale and blocks the code that already
  -- validates it.
  category              TEXT NOT NULL,
  severity              TEXT NOT NULL CHECK (severity IN ('critical', 'important', 'watch')),
  priority_score        REAL NOT NULL DEFAULT 0,

  title                 TEXT NOT NULL,
  concise_summary       TEXT NOT NULL,
  explanation           TEXT NOT NULL,
  recommendation        TEXT NOT NULL,

  affected_entity_type  TEXT NOT NULL CHECK (affected_entity_type IN ('sku', 'item', 'lot', 'serial_unit', 'location', 'workspace')),
  affected_entity_ids   TEXT NOT NULL DEFAULT '[]',
  -- Denormalised so the item page can ask "is anything wrong with this?" with
  -- an indexed lookup instead of unpacking every row's affected_entity_ids.
  item_id               TEXT REFERENCES items(id) ON DELETE CASCADE,
  sku_id                TEXT REFERENCES skus(id) ON DELETE CASCADE,
  affected_location_ids TEXT NOT NULL DEFAULT '[]',
  evidence_references   TEXT NOT NULL DEFAULT '[]',   -- movement ids, adjustment ids
  evidence              TEXT NOT NULL DEFAULT '[]',   -- readable fact list, JSON
  metrics               TEXT NOT NULL DEFAULT '{}',   -- the measured numbers, JSON
  related_categories    TEXT NOT NULL DEFAULT '[]',   -- merged-in signals

  confidence            TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  status                TEXT NOT NULL CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED')),
  resolution_reason     TEXT,
  detection_rule_version TEXT NOT NULL,

  -- Set when the interpretation layer rewords or re-ranks; the deterministic
  -- values above are never overwritten by it.
  narrative_title       TEXT,
  narrative_summary     TEXT,
  narrative_recommendation TEXT,
  narrative_source      TEXT,

  first_detected_at     TEXT NOT NULL,
  last_evaluated_at     TEXT NOT NULL,
  acknowledged_at       TEXT,
  dismissed_at          TEXT,
  dismissed_until       TEXT,
  resolved_at           TEXT,
  UNIQUE (workspace_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_attention_workspace_status ON attention_items(workspace_id, status, priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_attention_workspace_category ON attention_items(workspace_id, category);
CREATE INDEX IF NOT EXISTS idx_attention_item ON attention_items(workspace_id, item_id, status);

-- Feedback is recorded, never applied as a silent rule change.
CREATE TABLE IF NOT EXISTS attention_feedback (
  id            TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  attention_id  TEXT NOT NULL REFERENCES attention_items(id) ON DELETE CASCADE,
  verdict       TEXT NOT NULL CHECK (verdict IN ('useful', 'not_useful', 'dismissed', 'acknowledged', 'snoozed')),
  note          TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attention_feedback_item ON attention_feedback(attention_id, created_at);

-- Bookkeeping so scoped re-evaluation can be reasoned about and tested.
CREATE TABLE IF NOT EXISTS attention_runs (
  id            TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trigger       TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT '{}',
  opened        INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,
  resolved      INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attention_runs_workspace ON attention_runs(workspace_id, created_at DESC);

-- A lease, so the time-based sweep runs once across however many processes are
-- serving the application. Without it, two servers would both wake up on the
-- hour and evaluate the same workspaces against the same ledger.
CREATE TABLE IF NOT EXISTS attention_sweep_lease (
  id          TEXT PRIMARY KEY,        -- always 'sweep'
  holder      TEXT NOT NULL,           -- which process holds it
  expires_at  INTEGER NOT NULL,        -- epoch ms
  acquired_at TEXT NOT NULL
);

-- The daily brief is regenerated from current attention items; kept so the
-- Overview can render instantly and so we can prove it was grounded.
CREATE TABLE IF NOT EXISTS attention_briefs (
  id             TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  body           TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('deterministic', 'model')),
  item_ids       TEXT NOT NULL DEFAULT '[]',
  signature      TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attention_briefs_workspace ON attention_briefs(workspace_id, created_at DESC);
