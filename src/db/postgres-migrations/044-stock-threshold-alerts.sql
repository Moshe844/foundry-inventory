-- Owner-approved, workspace-scoped stock alerts. Evaluation is deterministic;
-- Ask only proposes the rule and never writes inventory or alert state itself.
CREATE TABLE IF NOT EXISTS stockchief_runtime.stock_threshold_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL REFERENCES public.skus(id) ON DELETE CASCADE,
  location_id TEXT REFERENCES public.locations(id) ON DELETE CASCADE,
  threshold BIGINT NOT NULL CHECK (threshold >= 0),
  armed BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  stated_as TEXT NOT NULL,
  approved_by_user_id TEXT NOT NULL REFERENCES public.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_threshold_rules_scope
  ON stockchief_runtime.stock_threshold_rules(workspace_id,sku_id,COALESCE(location_id,''));
CREATE INDEX IF NOT EXISTS stock_threshold_rules_active
  ON stockchief_runtime.stock_threshold_rules(workspace_id,is_active,sku_id);
