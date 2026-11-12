-- Job 127: creates products from a supplier catalog or price list. One record
-- per catalog file and supplier; one row per source line, saying whether it is
-- a new product, a product that already exists (linked, never duplicated), or
-- unclear and waiting for a person. Rows keep what was written so a run can be
-- undone exactly.
CREATE TABLE stockchief_runtime.agent_supplier_catalogs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  import_id text NOT NULL REFERENCES import_plans(id) ON DELETE CASCADE,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  source_name text NOT NULL,
  source_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('COLUMNS','WAITING','QUEUED','DONE','UNDONE','CANCELLED')),
  automatic boolean NOT NULL DEFAULT false,
  hold_reason text,
  pack_column int,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  approved_by text REFERENCES users(id) ON DELETE SET NULL,
  undone_by text REFERENCES users(id) ON DELETE SET NULL,
  revision int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_at timestamptz,
  done_at timestamptz,
  undone_at timestamptz
);
CREATE UNIQUE INDEX agent_supplier_catalog_source ON stockchief_runtime.agent_supplier_catalogs(workspace_id,source_hash,supplier_id)
  WHERE status NOT IN ('UNDONE','CANCELLED');
CREATE INDEX agent_supplier_catalogs_recent ON stockchief_runtime.agent_supplier_catalogs(workspace_id,created_at DESC,id);
CREATE INDEX agent_supplier_catalogs_waiting ON stockchief_runtime.agent_supplier_catalogs(workspace_id,status) WHERE status IN ('COLUMNS','WAITING');
CREATE INDEX agent_supplier_catalogs_import ON stockchief_runtime.agent_supplier_catalogs(import_id);
CREATE INDEX agent_supplier_catalogs_supplier ON stockchief_runtime.agent_supplier_catalogs(supplier_id);
CREATE INDEX agent_supplier_catalogs_creator ON stockchief_runtime.agent_supplier_catalogs(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX agent_supplier_catalogs_approver ON stockchief_runtime.agent_supplier_catalogs(approved_by) WHERE approved_by IS NOT NULL;
CREATE INDEX agent_supplier_catalogs_undoer ON stockchief_runtime.agent_supplier_catalogs(undone_by) WHERE undone_by IS NOT NULL;

-- kind: NEW (create), LINK (exists: link the supplier), SAME (already linked
-- with these terms), UNCLEAR (a person decides). decision is the person's
-- answer for an unclear row. status: PENDING waits for a person, READY is
-- approved for the worker, CREATING waits for the native import, DONE,
-- SKIPPED or UNDONE.
CREATE TABLE stockchief_runtime.agent_supplier_catalog_rows (
  catalog_id text NOT NULL REFERENCES stockchief_runtime.agent_supplier_catalogs(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  row_number bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('NEW','LINK','SAME','UNCLEAR')),
  decision text CHECK (decision IN ('CREATE','LINK','SKIP')),
  status text NOT NULL CHECK (status IN ('PENDING','READY','CREATING','DONE','SKIPPED','UNDONE')),
  name text,
  code text,
  supplier_code text,
  barcode text,
  options jsonb NOT NULL DEFAULT '[]',
  unit_label text,
  pack numeric,
  purchase_unit text,
  cost_minor bigint,
  currency text,
  target_sku_id text REFERENCES skus(id) ON DELETE SET NULL,
  reason text,
  derived_import_id text REFERENCES import_plans(id) ON DELETE SET NULL,
  created_sku_id text REFERENCES skus(id) ON DELETE SET NULL,
  link_id text,
  link_before jsonb,
  automatic boolean NOT NULL DEFAULT false,
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  done_at timestamptz,
  PRIMARY KEY (catalog_id,row_number)
);
CREATE INDEX agent_supplier_catalog_rows_open ON stockchief_runtime.agent_supplier_catalog_rows(workspace_id,catalog_id,status);
CREATE INDEX agent_supplier_catalog_rows_import ON stockchief_runtime.agent_supplier_catalog_rows(derived_import_id) WHERE derived_import_id IS NOT NULL;
CREATE INDEX agent_supplier_catalog_rows_target ON stockchief_runtime.agent_supplier_catalog_rows(target_sku_id) WHERE target_sku_id IS NOT NULL;
CREATE INDEX agent_supplier_catalog_rows_created ON stockchief_runtime.agent_supplier_catalog_rows(created_sku_id) WHERE created_sku_id IS NOT NULL;
CREATE INDEX agent_supplier_catalog_rows_person ON stockchief_runtime.agent_supplier_catalog_rows(decided_by) WHERE decided_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_supplier_catalogs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_supplier_catalog_rows'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation IN ('stockchief_runtime.agent_supplier_catalogs'::regclass,'stockchief_runtime.agent_supplier_catalog_rows'::regclass);
