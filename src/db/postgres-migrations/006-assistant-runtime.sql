CREATE TABLE IF NOT EXISTS stockchief_runtime.assistant_interactions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  message TEXT NOT NULL,
  intent JSONB NOT NULL,
  answer TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('ANSWERED','CLARIFY','PREPARED','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_interactions_workspace_time
  ON stockchief_runtime.assistant_interactions(workspace_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS stockchief_runtime.assistant_action_proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL CHECK (action_type IN
    ('inventory.receive','inventory.issue','inventory.transfer','inventory.adjust','catalog.create_item','location.create')),
  payload JSONB NOT NULL,
  summary TEXT NOT NULL,
  source_message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','EXECUTING','EXECUTED','CANCELLED')),
  idempotency_key TEXT NOT NULL,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  UNIQUE(workspace_id,idempotency_key)
);

CREATE INDEX IF NOT EXISTS assistant_action_proposals_workspace_status
  ON stockchief_runtime.assistant_action_proposals(workspace_id,status,created_at DESC);
