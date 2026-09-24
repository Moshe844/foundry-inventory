CREATE SCHEMA IF NOT EXISTS stockchief_runtime;

CREATE TABLE stockchief_runtime.jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','RETRY','COMPLETED','DEAD','CANCELLED')),
  priority INTEGER NOT NULL DEFAULT 100,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  available_at BIGINT NOT NULL,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at BIGINT,
  idempotency_key TEXT NOT NULL,
  result JSONB,
  last_error JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE NULLS NOT DISTINCT (kind, workspace_id, idempotency_key),
  CHECK ((status = 'RUNNING') = (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX jobs_claim ON stockchief_runtime.jobs (priority, created_at, id)
  WHERE status IN ('PENDING','RETRY');
CREATE INDEX jobs_expiry ON stockchief_runtime.jobs (lease_expires_at) WHERE status = 'RUNNING';

CREATE TABLE stockchief_runtime.job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES stockchief_runtime.jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX job_events_history ON stockchief_runtime.job_events (job_id, created_at, id);

CREATE FUNCTION stockchief_runtime.keep_job_events() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Job events are immutable';
END;
$$;
CREATE TRIGGER job_events_no_update BEFORE UPDATE ON stockchief_runtime.job_events
  FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.keep_job_events();
