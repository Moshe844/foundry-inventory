-- Ask capability plans are the durable mission record.  Extend them rather
-- than introducing a second workflow engine beside the canonical capability
-- registry and proposal executor.
ALTER TABLE stockchief_runtime.assistant_capability_plans
  DROP CONSTRAINT IF EXISTS assistant_capability_plans_status_check;

ALTER TABLE stockchief_runtime.assistant_capability_plans
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS plan_hash TEXT,
  ADD COLUMN IF NOT EXISTS approved_steps JSONB,
  ADD COLUMN IF NOT EXISTS authorization_mode TEXT NOT NULL DEFAULT 'STEP'
    CHECK (authorization_mode IN ('STEP','MISSION','STANDING')),
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED'
    CHECK (approval_status IN ('NOT_REQUESTED','PENDING','APPROVED','REVOKED')),
  ADD COLUMN IF NOT EXISTS approved_by_user_id TEXT REFERENCES public.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS waiting_condition JSONB,
  ADD COLUMN IF NOT EXISTS metrics JSONB NOT NULL DEFAULT
    '{"outcomeSpecifications":1,"approvalInteractions":0,"clarificationInteractions":0,"automaticSteps":0,"userInterventions":0,"externalWaits":0,"resumptions":0}'::jsonb,
  ADD COLUMN IF NOT EXISTS result JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (verification_status IN ('PENDING','VERIFIED','FAILED')),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE stockchief_runtime.assistant_capability_plans
  ADD CONSTRAINT assistant_capability_plans_status_check
  CHECK (status IN ('WAITING','ADVANCING','WAITING_EVENT','WAITING_USER','BLOCKED','DONE','CANCELLED'));

CREATE INDEX IF NOT EXISTS assistant_capability_plans_resumable
  ON stockchief_runtime.assistant_capability_plans(status,updated_at,id)
  WHERE status IN ('ADVANCING','WAITING_EVENT');

-- Durable memory is typed, provenance-bearing and never grants authority by
-- itself.  Business facts and preferences can be recalled by Ask; authority
-- continues to live in approved policies and frozen mission approvals.
CREATE TABLE IF NOT EXISTS stockchief_runtime.assistant_business_memory (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  memory_type TEXT NOT NULL CHECK (memory_type IN ('VERIFIED_FACT','PREFERENCE','OUTCOME')),
  memory_key TEXT NOT NULL,
  value JSONB NOT NULL,
  provenance JSONB NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('VERIFIED','OWNER_STATED')),
  source_actor_user_id TEXT REFERENCES public.users(id) ON DELETE SET NULL,
  source_record_type TEXT,
  source_record_id TEXT,
  effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS assistant_business_memory_active_key
  ON stockchief_runtime.assistant_business_memory(workspace_id,memory_type,memory_key)
  WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS assistant_business_memory_recent
  ON stockchief_runtime.assistant_business_memory(workspace_id,updated_at DESC,id);

-- Cross-domain reconciliation records what was checked and suspends automatic
-- work on material disagreement.  Checks are evidence, not inferred repairs.
CREATE TABLE IF NOT EXISTS stockchief_runtime.business_reconciliation_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','VERIFIED','FAILED')),
  material_issue_count INTEGER NOT NULL DEFAULT 0 CHECK (material_issue_count >= 0),
  check_count INTEGER NOT NULL DEFAULT 0 CHECK (check_count >= 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS business_reconciliation_runs_workspace
  ON stockchief_runtime.business_reconciliation_runs(workspace_id,started_at DESC,id);

CREATE TABLE IF NOT EXISTS stockchief_runtime.business_reconciliation_checks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES stockchief_runtime.business_reconciliation_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  invariant_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PASS','FAIL')),
  material BOOLEAN NOT NULL DEFAULT true,
  observed JSONB NOT NULL,
  expected JSONB NOT NULL,
  affected_records JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS business_reconciliation_checks_failures
  ON stockchief_runtime.business_reconciliation_checks(workspace_id,status,created_at DESC,id);

CREATE TABLE IF NOT EXISTS stockchief_runtime.workspace_reconciliation_state (
  workspace_id TEXT PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  last_run_id TEXT REFERENCES stockchief_runtime.business_reconciliation_runs(id) ON DELETE SET NULL,
  last_checked_at TIMESTAMPTZ,
  next_check_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','FAILED')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
