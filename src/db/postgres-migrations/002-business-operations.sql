CREATE TABLE stockchief_runtime.business_operations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED')),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (workspace_id, kind, idempotency_key)
);

CREATE INDEX business_operations_workspace
  ON stockchief_runtime.business_operations(workspace_id, created_at DESC);
