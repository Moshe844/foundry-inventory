-- Evaluation receipts are operational observations, never approval or rule edits.
-- Existing rules remain unknown until the existing worker actually checks them.
ALTER TABLE stockchief_runtime.stock_threshold_rules
  ADD COLUMN IF NOT EXISTS last_evaluated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_evaluation JSONB;
