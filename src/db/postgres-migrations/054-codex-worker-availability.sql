-- Operational availability only; no permissions, spending or business effects.
ALTER TABLE stockchief_runtime.codex_pilots ADD COLUMN worker_seen_at TIMESTAMPTZ;
ALTER TABLE stockchief_runtime.codex_pilots ADD COLUMN worker_identity TEXT;
