CREATE TABLE IF NOT EXISTS stockchief_runtime.report_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  definition JSONB NOT NULL,
  schedule_frequency TEXT NOT NULL DEFAULT 'none'
    CHECK (schedule_frequency IN ('none','daily','weekly')),
  schedule_hour_utc INTEGER NOT NULL DEFAULT 9 CHECK (schedule_hour_utc BETWEEN 0 AND 23),
  delivery_email TEXT,
  last_delivered_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_templates_workspace_owner
  ON stockchief_runtime.report_templates(workspace_id,owner_user_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS stockchief_runtime.report_deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES stockchief_runtime.report_templates(id) ON DELETE CASCADE,
  schedule_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SENT','FAILED')),
  email_job_id TEXT REFERENCES stockchief_runtime.jobs(id),
  row_count INTEGER,
  provider_message_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(template_id,schedule_key)
);
