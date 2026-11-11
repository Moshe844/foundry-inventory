CREATE TABLE stockchief_runtime.agent_shipping_document_readings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by text REFERENCES users(id) ON DELETE SET NULL,
  job_id text REFERENCES stockchief_runtime.jobs(id) ON DELETE SET NULL,
  attachment_id text REFERENCES connection_email_attachments(id) ON DELETE SET NULL,
  prior_filing_id text REFERENCES stockchief_runtime.agent_filed_documents(id) ON DELETE SET NULL,
  requested_po_id text REFERENCES purchase_orders(id) ON DELETE SET NULL,
  requested_po_hash text,
  source_message_id text,
  source_origin jsonb NOT NULL DEFAULT '{}',
  filename text NOT NULL,
  source_hash text NOT NULL,
  content bytea NOT NULL CHECK(octet_length(content)>0 AND octet_length(content)<=20971520),
  automatic boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','READY','FILED','FAILED')),
  document_kind text CHECK(document_kind IN ('bill_of_lading','customs')),
  original_sections jsonb NOT NULL DEFAULT '[]',
  evidence jsonb NOT NULL DEFAULT '{}',
  linked_documents jsonb NOT NULL DEFAULT '[]',
  document_usage_key text,
  owns_document_usage boolean NOT NULL DEFAULT false,
  documents_used integer NOT NULL DEFAULT 0,
  issue text,
  dismissed_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,source_hash)
);
CREATE INDEX shipping_reading_owner ON stockchief_runtime.agent_shipping_document_readings(requested_by);
CREATE INDEX shipping_reading_job ON stockchief_runtime.agent_shipping_document_readings(job_id);
CREATE INDEX shipping_reading_attachment ON stockchief_runtime.agent_shipping_document_readings(attachment_id) WHERE attachment_id IS NOT NULL;
CREATE INDEX shipping_reading_original_filing ON stockchief_runtime.agent_shipping_document_readings(prior_filing_id) WHERE prior_filing_id IS NOT NULL;
CREATE INDEX shipping_reading_purchase_order ON stockchief_runtime.agent_shipping_document_readings(requested_po_id) WHERE requested_po_id IS NOT NULL;
CREATE INDEX shipping_reading_history ON stockchief_runtime.agent_shipping_document_readings(workspace_id,created_at DESC,id);
CREATE INDEX shipping_reading_review ON stockchief_runtime.agent_shipping_document_readings(workspace_id,updated_at,id) WHERE status IN ('READY','FAILED') AND dismissed_at IS NULL;

ALTER TABLE stockchief_runtime.agent_filed_documents ADD COLUMN shipping_reading_id text REFERENCES stockchief_runtime.agent_shipping_document_readings(id) ON DELETE SET NULL;
CREATE INDEX filed_document_shipping_reading ON stockchief_runtime.agent_filed_documents(shipping_reading_id) WHERE shipping_reading_id IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_shipping_document_readings'::regclass,'octet_length(t.content)+octet_length(convert_to((to_jsonb(t)-''content'')::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_shipping_document_readings'::regclass,true FROM workspaces;
