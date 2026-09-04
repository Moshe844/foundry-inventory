-- ---------------------------------------------------------------------------
-- Prediction, and the record of having predicted
-- ---------------------------------------------------------------------------
--
-- Everything a forecast influences is somebody's money: an order placed early,
-- a target lowered, stock moved across town. So a prediction that changed a
-- decision has to survive the decision. Six months later the question is never
-- "what does the model say now" — it is "what did it say then, on what
-- evidence, and who let it act".
--
-- Three tables, in the order that question gets asked:
--
--   demand_forecasts          what was predicted, from what, how sure
--   forecast_outcomes         what actually happened, scored against it
--   planning_recommendations  what Foundry proposed, who decided, what followed
--
-- Nothing here is operational truth. A forecast is an opinion about the future
-- and cannot move stock, change a balance or post to the ledger; if every row
-- in these tables were deleted the business would still be exactly what it was.
-- That containment is deliberate — it is what makes it safe to let the
-- forecaster be wrong.

-- One stored prediction. Written when a forecast is used for something, not
-- every time one is calculated: a page that shows a projection is a question,
-- and storing an answer to every question would bury the ones that mattered.
CREATE TABLE IF NOT EXISTS demand_forecasts (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id            TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  location_id       TEXT REFERENCES locations(id) ON DELETE CASCADE,

  as_of             TEXT NOT NULL,           -- the day it was made, YYYY-MM-DD
  horizon_days      INTEGER NOT NULL,
  horizon_end       TEXT NOT NULL,           -- the last day it claims to cover

  -- The claim itself. daily_rate is null when Foundry declined to estimate,
  -- which is a real forecast outcome and must be storable.
  daily_rate        REAL,
  horizon_units     REAL,
  committed_units   INTEGER NOT NULL DEFAULT 0,

  confidence        TEXT NOT NULL CHECK (confidence IN ('learning', 'moderate', 'high')),
  model_id          TEXT,
  model_version     TEXT NOT NULL,

  -- The evidence as it stood, frozen. Re-deriving it later would answer a
  -- different question, because the history itself will have changed.
  evidence          TEXT NOT NULL DEFAULT '{}',
  backtest          TEXT NOT NULL DEFAULT '{}',
  calculation       TEXT NOT NULL DEFAULT '[]',

  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_demand_forecasts_sku
  ON demand_forecasts(workspace_id, sku_id, as_of);
CREATE INDEX IF NOT EXISTS ix_demand_forecasts_due
  ON demand_forecasts(workspace_id, horizon_end);

-- How it turned out. Written by the scoring pass once the horizon has closed
-- and the real demand is known, which is the only moment the comparison is
-- honest.
CREATE TABLE IF NOT EXISTS forecast_outcomes (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  forecast_id       TEXT NOT NULL REFERENCES demand_forecasts(id) ON DELETE CASCADE,
  sku_id            TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,

  scored_at         TEXT NOT NULL,
  predicted_units   REAL,
  actual_units      REAL NOT NULL,
  error_units       REAL,                    -- predicted − actual; sign matters
  absolute_error    REAL,
  -- Days inside the horizon that were out of stock. A forecast cannot be
  -- fairly marked against demand that had nowhere to happen.
  censored_days     INTEGER NOT NULL DEFAULT 0,
  comparable        INTEGER NOT NULL DEFAULT 1 CHECK (comparable IN (0, 1)),

  notes             TEXT,
  created_at        TEXT NOT NULL,

  UNIQUE (workspace_id, forecast_id)
);

CREATE INDEX IF NOT EXISTS ix_forecast_outcomes_sku
  ON forecast_outcomes(workspace_id, sku_id, scored_at);

-- What Foundry proposed, and everything that happened to the proposal.
--
-- One row covers the whole life of a recommendation: raised, shown, decided,
-- acted on, verified. Keeping it in one row rather than a stream of events is a
-- deliberate simplification — the question people ask is "what happened to that
-- suggestion", and it should not require assembling.
CREATE TABLE IF NOT EXISTS planning_recommendations (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  kind              TEXT NOT NULL,           -- reorder_point, target_stock, transfer, order_now, ...
  subject_type      TEXT NOT NULL,           -- sku, supplier, location, workspace
  subject_id        TEXT,
  sku_id            TEXT REFERENCES skus(id) ON DELETE CASCADE,
  supplier_id       TEXT REFERENCES suppliers(id) ON DELETE SET NULL,

  -- What it is asking for, in numbers a person can check.
  current_value     REAL,
  recommended_value REAL,

  headline          TEXT NOT NULL,
  why               TEXT NOT NULL,

  -- The prediction that produced it, so a bad recommendation can be traced to
  -- the forecast that caused it rather than argued about in the abstract.
  forecast_id       TEXT REFERENCES demand_forecasts(id) ON DELETE SET NULL,
  confidence        TEXT,
  evidence          TEXT NOT NULL DEFAULT '{}',

  -- The authority story. Which capability it needed, what the gate said, and
  -- what a person decided if it was put to one.
  capability        TEXT,
  authority_verdict TEXT CHECK (authority_verdict IN
                      ('authorized', 'needs_approval', 'refused')),
  authority_detail  TEXT NOT NULL DEFAULT '{}',

  status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN
                      ('OPEN', 'ACCEPTED', 'DECLINED', 'APPLIED', 'SUPERSEDED', 'EXPIRED')),
  decided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at        TEXT,

  -- What actually got done, if anything.
  resulting_action  TEXT,                    -- work_item id, purchase order id, policy id
  resulting_detail  TEXT NOT NULL DEFAULT '{}',

  -- Replay safety. The same shortage evaluated twice in a morning is one
  -- recommendation, not two, and certainly not two purchase orders.
  idempotency_key   TEXT NOT NULL,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,

  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ix_planning_recommendations_open
  ON planning_recommendations(workspace_id, status, kind);
CREATE INDEX IF NOT EXISTS ix_planning_recommendations_sku
  ON planning_recommendations(workspace_id, sku_id, status);
