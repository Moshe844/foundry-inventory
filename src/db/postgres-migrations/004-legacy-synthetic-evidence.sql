ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS synthetic_activated_at TEXT,
  ADD COLUMN IF NOT EXISTS synthetic_origin_request TEXT;

CREATE TABLE IF NOT EXISTS public.synthetic_generation_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  requested_by_user_id TEXT REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  originating_request TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  seed TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '{}',
  progress TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.synthetic_record_provenance (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  run_id TEXT NOT NULL REFERENCES public.synthetic_generation_runs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  generated_by TEXT NOT NULL DEFAULT 'Foundry',
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id,record_type,record_id)
);
