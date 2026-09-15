-- Mission 11: the evidence-backed comparison behind an inventory decision.
-- These rows are advisory snapshots. They never move stock, place an order,
-- or grant authority; the ordinary domain engines still own every mutation.

CREATE TABLE IF NOT EXISTS inventory_decision_plans (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id              TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  as_of               TEXT NOT NULL,
  horizon_end         TEXT NOT NULL,
  objective           TEXT NOT NULL DEFAULT '{}',
  constraints         TEXT NOT NULL DEFAULT '{}',
  alternatives        TEXT NOT NULL DEFAULT '[]',
  chosen_plan         TEXT NOT NULL DEFAULT '{}',
  expected_result     TEXT NOT NULL DEFAULT '{}',
  actual_result       TEXT NOT NULL DEFAULT '{}',
  confidence          TEXT NOT NULL,
  uncertainty         TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'SHADOW'
                        CHECK (status IN ('SHADOW','SCORED','SUPERSEDED','INFEASIBLE')),
  shadow              INTEGER NOT NULL DEFAULT 1 CHECK (shadow IN (0,1)),
  idempotency_key     TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  scored_at           TEXT,
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ix_inventory_decision_plans_sku
  ON inventory_decision_plans(workspace_id, sku_id, as_of DESC);
CREATE INDEX IF NOT EXISTS ix_inventory_decision_plans_score
  ON inventory_decision_plans(workspace_id, status, horizon_end);

-- Optional planning evidence that must come from a person, provider or
-- document. It gives the optimiser facts such as a real promotion uplift,
-- expedited supplier service or an approved substitute. Missing evidence
-- remains missing; no default value is manufactured.
CREATE TABLE IF NOT EXISTS inventory_decision_evidence (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id              TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN
                        ('PROMOTION','SEASONALITY','EXPEDITE','SUBSTITUTE',
                         'TRANSFER_TIMING','TRANSFER_COST','STOCKOUT_COST','STORAGE_COST')),
  related_sku_id      TEXT REFERENCES skus(id) ON DELETE CASCADE,
  supplier_id         TEXT REFERENCES suppliers(id) ON DELETE CASCADE,
  location_id         TEXT REFERENCES locations(id) ON DELETE CASCADE,
  value               TEXT NOT NULL DEFAULT '{}',
  source_type         TEXT NOT NULL CHECK (source_type IN ('owner','document','provider','record')),
  source_id           TEXT,
  verified_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  effective_from      TEXT,
  effective_to        TEXT,
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_inventory_decision_evidence_active
  ON inventory_decision_evidence(workspace_id, sku_id, kind, active);
