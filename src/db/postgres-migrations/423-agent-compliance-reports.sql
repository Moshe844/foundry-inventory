-- Job 197: audit and compliance reports prepared from recorded data. Each
-- report freezes what it found for its period, so a finalized report never
-- changes when later records do. Growth drafts each report for a person to
-- finalize; Pro and Custom produce them on the owner's schedule.
CREATE TABLE stockchief_runtime.agent_compliance_schedules (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  frequency text NOT NULL CHECK (frequency IN ('WEEKLY','MONTHLY')),
  enabled boolean NOT NULL DEFAULT true,
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  revision int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_compliance_schedule_owner ON stockchief_runtime.agent_compliance_schedules(authorized_by) WHERE authorized_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_compliance_reports (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_key text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end>=period_start),
  status text NOT NULL CHECK (status IN ('DRAFT','FINAL','DISCARDED')),
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  gaps int NOT NULL DEFAULT 0 CHECK (gaps>=0),
  reason text,
  would_finalize boolean NOT NULL DEFAULT false,
  automatic boolean NOT NULL DEFAULT false,
  scheduled boolean NOT NULL DEFAULT false,
  prepared_by text REFERENCES users(id) ON DELETE SET NULL,
  finalized_by text REFERENCES users(id) ON DELETE SET NULL,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id,request_key),
  CHECK (status<>'FINAL' OR finalized_at IS NOT NULL)
);
CREATE INDEX agent_compliance_reports_recent ON stockchief_runtime.agent_compliance_reports(workspace_id,created_at DESC,id);
CREATE INDEX agent_compliance_reports_waiting ON stockchief_runtime.agent_compliance_reports(workspace_id,created_at) WHERE status='DRAFT';
CREATE INDEX agent_compliance_reports_preparer ON stockchief_runtime.agent_compliance_reports(prepared_by) WHERE prepared_by IS NOT NULL;
CREATE INDEX agent_compliance_reports_finalizer ON stockchief_runtime.agent_compliance_reports(finalized_by) WHERE finalized_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_compliance_schedules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_compliance_reports'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation IN ('stockchief_runtime.agent_compliance_schedules'::regclass,'stockchief_runtime.agent_compliance_reports'::regclass);
