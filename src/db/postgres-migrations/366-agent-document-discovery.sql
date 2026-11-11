CREATE TABLE stockchief_runtime.agent_document_filing_scopes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  party_kind text NOT NULL CHECK(party_kind IN('supplier','customer')),
  party_id text NOT NULL,
  scope_identity jsonb NOT NULL,
  target_kinds text[] NOT NULL CHECK(cardinality(target_kinds)>0 AND target_kinds <@ ARRAY['purchase_order','sales_order','item']::text[]),
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,connector_id,party_kind,party_id)
);
CREATE INDEX document_filing_scope_connector ON stockchief_runtime.agent_document_filing_scopes(connector_id);
CREATE INDEX document_filing_scope_actor ON stockchief_runtime.agent_document_filing_scopes(authorized_by);
CREATE INDEX document_filing_scope_lookup ON stockchief_runtime.agent_document_filing_scopes(workspace_id,connector_id,party_kind) WHERE enabled;

CREATE TABLE stockchief_runtime.agent_document_discoveries (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  job_id text REFERENCES stockchief_runtime.jobs(id) ON DELETE SET NULL,
  scope_id text REFERENCES stockchief_runtime.agent_document_filing_scopes(id) ON DELETE SET NULL,
  scope_revision integer,
  attachment_id text REFERENCES connection_email_attachments(id) ON DELETE SET NULL,
  source_message_id text,
  source_identity jsonb NOT NULL,
  source_key text NOT NULL,
  source_hash text NOT NULL,
  filename text NOT NULL,
  mime_type text,
  content bytea NOT NULL CHECK(octet_length(content)>0 AND octet_length(content)<=20971520),
  automatic boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','RUNNING','REVIEW','FILED','FAILED')),
  document_kind text NOT NULL DEFAULT 'other' CHECK(document_kind IN('other','packing_slip','bill_of_lading','customs','specification','safety_sheet','contract')),
  sections jsonb NOT NULL DEFAULT '[]',
  evidence jsonb NOT NULL DEFAULT '{}',
  filings jsonb NOT NULL DEFAULT '[]',
  usage_key text,
  owns_usage boolean NOT NULL DEFAULT false,
  documents_used integer NOT NULL DEFAULT 0,
  issue text,
  dismissed_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,source_key)
);
CREATE INDEX document_discovery_actor ON stockchief_runtime.agent_document_discoveries(actor_id);
CREATE INDEX document_discovery_job ON stockchief_runtime.agent_document_discoveries(job_id);
CREATE INDEX document_discovery_scope ON stockchief_runtime.agent_document_discoveries(scope_id);
CREATE INDEX document_discovery_attachment ON stockchief_runtime.agent_document_discoveries(attachment_id);
CREATE INDEX document_discovery_history ON stockchief_runtime.agent_document_discoveries(workspace_id,created_at DESC,id);
CREATE INDEX document_discovery_review ON stockchief_runtime.agent_document_discoveries(workspace_id,updated_at,id) WHERE status IN('REVIEW','FAILED') AND dismissed_at IS NULL;
ALTER TABLE stockchief_runtime.agent_filed_documents ADD COLUMN discovery_id text REFERENCES stockchief_runtime.agent_document_discoveries(id) ON DELETE SET NULL;
CREATE INDEX filed_document_discovery ON stockchief_runtime.agent_filed_documents(discovery_id) WHERE discovery_id IS NOT NULL;
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_document_filing_scopes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_document_discoveries'::regclass,'octet_length(t.content)+octet_length(convert_to((to_jsonb(t)-''content'')::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_document_filing_scopes'::regclass,'stockchief_runtime.agent_document_discoveries'::regclass])r;

CREATE INDEX commercial_document_read_source_hash ON commercial_usage_events(account_id,workspace_id,
  (COALESCE(detail->>'sourceHash',CASE WHEN left(right(idempotency_key,65),1)=':' THEN right(idempotency_key,64) END)))
  WHERE meter='agent_documents' AND status IN('COMMITTED','RESERVED') AND units>=1;
