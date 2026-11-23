-- An upload intent is scoped before issuing any upload authority. The immutable
-- S3 version is fixed before it becomes an ordinary durable preview job.
CREATE TABLE import_external_uploads (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key text NOT NULL,
  source_name text NOT NULL,
  source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  source_bytes bigint NOT NULL CHECK(source_bytes>0),
  object_key text NOT NULL UNIQUE,
  version_id text,
  input_options jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  UNIQUE(workspace_id,actor_id,request_key),
  CHECK((input_options->>'isText') IS NULL)
);
CREATE INDEX import_external_uploads_expiry ON import_external_uploads(expires_at);

-- Transactional outbox: enqueue and notification intent commit together.
-- Publishing may repeat after a crash; durable job claims make that harmless.
CREATE TABLE stockchief_runtime.import_transport_outbox (
  job_id text PRIMARY KEY REFERENCES stockchief_runtime.jobs(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION stockchief_import_transport_enqueued() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stockchief_runtime.import_transport_outbox(job_id,workspace_id)
  SELECT id,workspace_id FROM new_jobs WHERE workspace_id IS NOT NULL AND kind IN ('import.analyse-source.aws','import.execute-approved')
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER import_transport_enqueued AFTER INSERT ON stockchief_runtime.jobs
  REFERENCING NEW TABLE AS new_jobs FOR EACH STATEMENT EXECUTE FUNCTION stockchief_import_transport_enqueued();

-- Register both scoped metadata tables with the existing background storage
-- measurement. This adds no per-row storage trigger or quota lock to imports.
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('import_external_uploads'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.import_transport_outbox'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN (VALUES
    ('import_external_uploads'::regclass),
    ('stockchief_runtime.import_transport_outbox'::regclass)) r(relation);
