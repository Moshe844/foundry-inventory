-- Verification finishes before deferred constraints and COMMIT finish. Keep a
-- distinct observed commit receipt without rewriting historical check times.
ALTER TABLE import_executions ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ;
