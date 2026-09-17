-- The assistant's ledger: what was asked, in how many parts, and what became
-- of each part.
--
-- A message is a turn. A turn has one or more goals — "move 5 elbows to the
-- store" and "draft an email to Acme" are two goals in one sentence — and
-- every goal ends in exactly one status the person can read: done, needs
-- approval, needs an answer, handed to a page, refused, failed, or still
-- waiting. Nothing said to StockChief is dropped without a row saying so.
--
-- A turn also leaves referents behind: the PO it drafted, the proposal it
-- prepared, the message it wrote. "That PO" in the next message resolves
-- against these, not against a regex over the last sentence.

CREATE TABLE IF NOT EXISTS assistant_turns (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- One conversation per "New conversation" press; the Ask page shows one.
  conversation_id  TEXT NOT NULL,
  -- 'ask' from the Ask page, 'tell' from the Brief's box, 'continue' when
  -- StockChief itself submitted a queued goal.
  channel          TEXT NOT NULL DEFAULT 'tell',
  message          TEXT NOT NULL,
  -- The understanding, as JSON: continuesPrevious, goals, referents used.
  understanding    TEXT NOT NULL DEFAULT '{}',
  continues_turn_id TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_turns_conversation
  ON assistant_turns(workspace_id, user_id, conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assistant_goals (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  turn_id          TEXT NOT NULL REFERENCES assistant_turns(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  -- lookup | change | send | communication | instruction | report | navigate | unsupported | unclear
  kind             TEXT NOT NULL DEFAULT 'unclear',
  text             TEXT NOT NULL,
  -- pending | answered | needs_approval | drafted | clarify | handed | refused | failed | done | skipped
  status           TEXT NOT NULL DEFAULT 'pending',
  -- The sentence StockChief said about this goal, when it said one.
  said             TEXT,
  result_href      TEXT,
  result_label     TEXT,
  -- Where the answer came from, as JSON: intent, dataset, filters, rowCount,
  -- asOf. Empty when nothing was read.
  provenance       TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_goals_turn ON assistant_goals(turn_id, position);

CREATE TABLE IF NOT EXISTS assistant_referents (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  turn_id          TEXT NOT NULL REFERENCES assistant_turns(id) ON DELETE CASCADE,
  -- purchase_order | proposal | plan | sales_order | message | price_change | product | customer | supplier | page
  kind             TEXT NOT NULL,
  ref_id           TEXT NOT NULL,
  -- What a person would call it: "PO-1024", "the transfer of 20 Copper Elbow".
  label            TEXT NOT NULL,
  href             TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_referents_turn ON assistant_referents(turn_id, created_at DESC);

-- Every model call and every tool call, on the record: what it was for, how
-- long it took, what it cost, and how it ended. The prompt is kept redacted —
-- quoted text and figures masked — for thirty days, so a wrong answer can be
-- traced to the call that produced it without keeping record values around.
CREATE TABLE IF NOT EXISTS ai_calls (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT,
  actor_id         TEXT,
  goal_id          TEXT,
  -- 'model' for a provider call, 'tool' for a registered tool call.
  kind             TEXT NOT NULL,
  -- The schema name of a model call, or the tool id.
  purpose          TEXT NOT NULL,
  provider         TEXT,
  model            TEXT,
  prompt_hash      TEXT,
  prompt_redacted  TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  latency_ms       INTEGER NOT NULL,
  -- ok, failed, refused, timeout, invalid_output
  outcome          TEXT NOT NULL,
  error            TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_workspace ON ai_calls(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_calls_goal ON ai_calls(goal_id);

-- The facts a message StockChief wrote was written from, kept beside the
-- message so its page can show them: what was relied on, and everything
-- that was available. Dictated messages have no row here.
CREATE TABLE IF NOT EXISTS assistant_draft_facts (
  message_id    TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  facts         TEXT NOT NULL DEFAULT '[]',
  facts_used    TEXT NOT NULL DEFAULT '[]',
  instruction   TEXT,
  created_at    TEXT NOT NULL
);
