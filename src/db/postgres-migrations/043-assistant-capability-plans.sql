-- Capability IDs are checked against the application registry before a proposal
-- is created or executed. A database enum would make each new registered
-- capability require a phrase-era migration as well.
ALTER TABLE stockchief_runtime.assistant_action_proposals
  DROP CONSTRAINT IF EXISTS assistant_action_proposals_action_type_check;

CREATE TABLE IF NOT EXISTS stockchief_runtime.assistant_capability_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  batch_id TEXT NOT NULL,
  source_message TEXT NOT NULL,
  steps JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('WAITING','ADVANCING','BLOCKED','DONE','CANCELLED')),
  waiting_proposal_id TEXT REFERENCES stockchief_runtime.assistant_action_proposals(id),
  run_token TEXT,
  run_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,waiting_proposal_id)
);

CREATE INDEX IF NOT EXISTS assistant_capability_plans_workspace_status
  ON stockchief_runtime.assistant_capability_plans(workspace_id,status,updated_at DESC);
