-- Pauses of the web server, recorded by src/operations/web-stall-monitor.js so
-- slow pages can be explained from inside the process: how long it stopped,
-- what was running, memory clean-up pauses, memory, and container CPU
-- throttling. Kept for three days.
CREATE TABLE IF NOT EXISTS stockchief_runtime.web_stalls (
  id TEXT PRIMARY KEY,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ix_web_stalls_observed ON stockchief_runtime.web_stalls (observed_at DESC);
