-- Job 199: how sure StockChief must be to act on its own. 'medium' (the
-- default when no row exists) acts when it is fairly or very sure; 'high'
-- acts only when it is very sure. Below that, and always when it is unsure
-- (low), it asks a person instead. One row per inventory, set by the owner.
CREATE TABLE stockchief_runtime.agent_confidence_settings (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  minimum text NOT NULL CHECK (minimum IN ('medium','high')),
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
