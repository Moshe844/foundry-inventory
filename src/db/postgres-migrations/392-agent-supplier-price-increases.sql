ALTER TABLE stockchief_runtime.agent_operational_notices
  DROP CONSTRAINT agent_operational_notices_job_id_check,
  ADD CONSTRAINT agent_operational_notices_job_id_check
    CHECK (job_id IN (10,50,67,77,80,82,87,88,91,110,116,124,167,168,169,170,171,204,206,209));

CREATE TABLE stockchief_runtime.agent_supplier_price_lists (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  supplier_id text REFERENCES suppliers(id) ON DELETE SET NULL,
  uploaded_by text REFERENCES users(id) ON DELETE SET NULL,
  filename text NOT NULL,
  confirmed_currency text,
  content_hash text NOT NULL,
  original bytea NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','READY','HELD')),
  problem text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  checked_at timestamptz,
  reviewed_at timestamptz,
  confirmed_by text REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  confirmation_hash text,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,content_hash)
);
CREATE INDEX agent_supplier_price_lists_recent
  ON stockchief_runtime.agent_supplier_price_lists(workspace_id,created_at DESC,id);

CREATE TABLE stockchief_runtime.agent_supplier_price_list_findings (
  workspace_id text NOT NULL,
  source_id text NOT NULL,
  ordinal int NOT NULL,
  sku_id text REFERENCES skus(id) ON DELETE SET NULL,
  sku_code text NOT NULL,
  sheet text NOT NULL,
  row_number int NOT NULL,
  quote jsonb NOT NULL,
  currency text,
  amount_minor bigint,
  pricing_quantity numeric,
  prior jsonb,
  result text NOT NULL CHECK (result IN ('HIGHER','NO_INCREASE','HELD')),
  reason text,
  PRIMARY KEY(workspace_id,source_id,ordinal),
  FOREIGN KEY(workspace_id,source_id) REFERENCES stockchief_runtime.agent_supplier_price_lists(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX agent_supplier_price_list_higher
  ON stockchief_runtime.agent_supplier_price_list_findings(workspace_id,source_id,sku_id) WHERE result='HIGHER';

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_supplier_price_lists'::regclass,'octet_length(t.original)+octet_length(convert_to((
    SELECT to_jsonb(metadata) FROM (SELECT t.workspace_id,t.id,t.supplier_id,t.uploaded_by,t.filename,t.confirmed_currency,
      t.content_hash,t.status,t.problem,t.created_at,t.checked_at,t.reviewed_at,t.confirmed_by,t.confirmed_at,t.confirmation_hash) metadata
    )::text,''UTF8''))'),
  ('stockchief_runtime.agent_supplier_price_list_findings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation IN ('stockchief_runtime.agent_supplier_price_lists'::regclass,'stockchief_runtime.agent_supplier_price_list_findings'::regclass);
