CREATE TABLE stockchief_runtime.lot_certificate_sources (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  filename text NOT NULL,
  source_hash text NOT NULL,
  content bytea NOT NULL,
  original_attachment_id text REFERENCES connection_email_attachments(id) ON DELETE SET NULL,
  filed_document_id text REFERENCES stockchief_runtime.agent_filed_documents(id) ON DELETE SET NULL,
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  review_reason text,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id,id), UNIQUE (workspace_id,source_hash)
);
CREATE INDEX lot_certificate_sources_attachment ON stockchief_runtime.lot_certificate_sources(original_attachment_id) WHERE original_attachment_id IS NOT NULL;
CREATE INDEX lot_certificate_sources_filed ON stockchief_runtime.lot_certificate_sources(filed_document_id) WHERE filed_document_id IS NOT NULL;
CREATE INDEX lot_certificate_sources_actor ON stockchief_runtime.lot_certificate_sources(actor_id);
CREATE INDEX lot_certificate_source_review ON stockchief_runtime.lot_certificate_sources(workspace_id,created_at DESC,id) WHERE review_reason IS NOT NULL AND dismissed_at IS NULL;

CREATE TABLE stockchief_runtime.lot_certificate_links (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lot_id text NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('CoA','Safety sheet')),
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','LINKED','REVOKED')),
  expires_on date,
  proof jsonb NOT NULL DEFAULT '{}',
  identity_hash text NOT NULL,
  automatic boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  prepared_by text REFERENCES users(id) ON DELETE SET NULL,
  linked_by text REFERENCES users(id) ON DELETE SET NULL,
  linked_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id,source_id) REFERENCES stockchief_runtime.lot_certificate_sources(workspace_id,id) ON DELETE CASCADE,
  UNIQUE (workspace_id,lot_id,kind,source_id)
);
CREATE INDEX lot_certificate_links_lot ON stockchief_runtime.lot_certificate_links(lot_id);
CREATE INDEX lot_certificate_links_source ON stockchief_runtime.lot_certificate_links(workspace_id,source_id);
CREATE INDEX lot_certificate_links_prepared_by ON stockchief_runtime.lot_certificate_links(prepared_by);
CREATE INDEX lot_certificate_links_linked_by ON stockchief_runtime.lot_certificate_links(linked_by);
CREATE INDEX lot_certificate_current_links ON stockchief_runtime.lot_certificate_links(workspace_id,lot_id,kind,expires_on) WHERE state='LINKED';
CREATE INDEX lot_certificate_pending_links ON stockchief_runtime.lot_certificate_links(workspace_id,created_at DESC,id) WHERE state='DRAFT';

CREATE TABLE stockchief_runtime.lot_certificate_rules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  kinds text[] NOT NULL CHECK (cardinality(kinds)>0 AND kinds <@ ARRAY['CoA','Safety sheet']::text[]),
  source_identity jsonb NOT NULL,
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  mode text NOT NULL CHECK (mode IN ('draft','automatic')),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id,sku_id,supplier_id,connector_id)
);
CREATE INDEX lot_certificate_rule_mail ON stockchief_runtime.lot_certificate_rules(workspace_id,connector_id,supplier_id) WHERE enabled;
CREATE INDEX lot_certificate_rule_sku ON stockchief_runtime.lot_certificate_rules(sku_id);
CREATE INDEX lot_certificate_rule_supplier ON stockchief_runtime.lot_certificate_rules(supplier_id);
CREATE INDEX lot_certificate_rule_connector ON stockchief_runtime.lot_certificate_rules(connector_id);
CREATE INDEX lot_certificate_rule_owner ON stockchief_runtime.lot_certificate_rules(authorized_by);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.lot_certificate_sources'::regclass,'octet_length(t.content)+octet_length(convert_to((to_jsonb(t)-''content'')::text,''UTF8''))'),
 ('stockchief_runtime.lot_certificate_links'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.lot_certificate_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.lot_certificate_sources'::regclass,'stockchief_runtime.lot_certificate_links'::regclass,'stockchief_runtime.lot_certificate_rules'::regclass])r;

CREATE INDEX lot_certificate_serial_stock ON serial_units(workspace_id,lot_id) WHERE status='in_stock' AND lot_id IS NOT NULL;
CREATE INDEX lot_certificate_direct_lots ON stockchief_runtime.agent_direct_lots(workspace_id,lot_id);
CREATE INDEX lot_certificate_receipt_lots ON purchase_order_receipt_lines(workspace_id,lot_id) WHERE lot_id IS NOT NULL;
