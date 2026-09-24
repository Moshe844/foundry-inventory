CREATE TABLE IF NOT EXISTS stockchief_runtime.provider_effects (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  provider text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','AMBIGUOUS','CANCELLED')),
  requested_by_user_id text REFERENCES public.users(id) ON DELETE SET NULL,
  claim_token text,
  claimed_at timestamptz,
  provider_reference jsonb,
  result jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,kind,idempotency_key),
  CHECK ((status='RUNNING')=(claim_token IS NOT NULL AND claimed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS provider_effects_aggregate
  ON stockchief_runtime.provider_effects(workspace_id,aggregate_type,aggregate_id,created_at DESC);

CREATE INDEX IF NOT EXISTS provider_effects_recovery
  ON stockchief_runtime.provider_effects(status,claimed_at)
  WHERE status='RUNNING';
