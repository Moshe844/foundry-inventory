-- Existing rules retain their original physical on-hand, at-or-below meaning.
ALTER TABLE stockchief_runtime.stock_threshold_rules
  ADD COLUMN IF NOT EXISTS metric TEXT NOT NULL DEFAULT 'on_hand'
    CHECK (metric IN ('on_hand','available_to_fulfill'));
ALTER TABLE stockchief_runtime.stock_threshold_rules
  ADD COLUMN IF NOT EXISTS comparator TEXT NOT NULL DEFAULT 'at_or_below'
    CHECK (comparator IN ('below','at_or_below'));
