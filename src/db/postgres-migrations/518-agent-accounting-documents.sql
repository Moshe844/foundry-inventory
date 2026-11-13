-- Job 184: customer invoices and supplier bills sent to QuickBooks or Xero as
-- invoices and bills, built from their own books entries.
--
-- The owner turns this on for one connected set of books, from a start date.
-- Invoices and bills on or after that date go as documents; their books entries
-- then go as journals only for what the document does not already carry (for
-- example the cost of goods on a shipment), so nothing is counted twice.
-- On Pro, sending on its own is taught by the saved rule below (send_alone) or
-- by a document the owner approved that the books confirmed.
CREATE TABLE stockchief_runtime.agent_accounting_document_settings (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  invoices boolean NOT NULL DEFAULT true,
  bills boolean NOT NULL DEFAULT true,
  start_date text NOT NULL CHECK (start_date ~ '^\d{4}-\d{2}-\d{2}$'),
  send_alone boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,connector_id),
  CHECK (invoices OR bills)
);
CREATE INDEX agent_accounting_document_settings_connector ON stockchief_runtime.agent_accounting_document_settings(connector_id);
CREATE INDEX agent_accounting_document_settings_author ON stockchief_runtime.agent_accounting_document_settings(updated_by);

-- What the books call the things StockChief has no stored link for yet: the tax
-- code for taxed and untaxed sales and purchases, and (QuickBooks) the product
-- or service an income account's sales go under. Contacts and accounts keep
-- their existing links on the connection.
CREATE TABLE stockchief_runtime.agent_accounting_mappings (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('tax_code','sales_item')),
  local_key text NOT NULL CHECK (length(local_key) BETWEEN 1 AND 200),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 100),
  mapped_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,connector_id,kind,local_key)
);
CREATE INDEX agent_accounting_mappings_connector ON stockchief_runtime.agent_accounting_mappings(connector_id);
CREATE INDEX agent_accounting_mappings_author ON stockchief_runtime.agent_accounting_mappings(mapped_by);

-- One row per invoice or bill and set of books: the exact document StockChief
-- built (or why it stopped), the books entry lines it carries, and what
-- happened: sent on its own, waiting for approval, watched only, stopped for a
-- person, already in the books as a journal, or dismissed to go as a journal.
CREATE TABLE stockchief_runtime.agent_accounting_documents (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  document_kind text NOT NULL CHECK (document_kind IN ('invoice','bill')),
  document_id text NOT NULL,
  journal_entry_id text REFERENCES accounting_journal_entries(id) ON DELETE SET NULL,
  number text NOT NULL,
  contact_name text,
  status text NOT NULL CHECK (status IN ('WATCHED','HELD','DRAFTED','QUEUED','SENT','FAILED','UNCERTAIN','IN_BOOKS','DISMISSED')),
  reason text,
  need jsonb,
  fingerprint text,
  payload jsonb,
  covered_lines text[] NOT NULL DEFAULT '{}',
  effect_id text,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt>=0),
  external_id text,
  automatic boolean NOT NULL DEFAULT false,
  approved_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,connector_id,document_kind,document_id),
  CHECK (status NOT IN ('QUEUED','SENT','UNCERTAIN') OR (fingerprint IS NOT NULL AND payload IS NOT NULL AND effect_id IS NOT NULL)),
  CHECK (status<>'SENT' OR external_id IS NOT NULL)
);
CREATE INDEX agent_accounting_documents_connector ON stockchief_runtime.agent_accounting_documents(connector_id);
CREATE INDEX agent_accounting_documents_journal ON stockchief_runtime.agent_accounting_documents(workspace_id,connector_id,journal_entry_id) WHERE journal_entry_id IS NOT NULL;
CREATE INDEX agent_accounting_documents_journal_fk ON stockchief_runtime.agent_accounting_documents(journal_entry_id) WHERE journal_entry_id IS NOT NULL;
CREATE INDEX agent_accounting_documents_approver ON stockchief_runtime.agent_accounting_documents(approved_by) WHERE approved_by IS NOT NULL;
CREATE INDEX agent_accounting_documents_waiting ON stockchief_runtime.agent_accounting_documents(workspace_id,updated_at) WHERE status IN ('WATCHED','HELD','DRAFTED','FAILED','UNCERTAIN');
CREATE INDEX agent_accounting_documents_recent ON stockchief_runtime.agent_accounting_documents(workspace_id,updated_at DESC,document_id);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_accounting_document_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_accounting_mappings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_accounting_documents'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN (VALUES
    ('stockchief_runtime.agent_accounting_document_settings'::regclass),
    ('stockchief_runtime.agent_accounting_mappings'::regclass),
    ('stockchief_runtime.agent_accounting_documents'::regclass)) r(relation);
