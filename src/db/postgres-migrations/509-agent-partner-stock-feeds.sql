-- Job 123: stock reported by fulfilment partners (3PLs) and consignment
-- partners, kept separate from StockChief's own records and compared with them.
CREATE TABLE stockchief_runtime.agent_partner_locations (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('three_pl','consignment')),
  source text NOT NULL CHECK (source IN ('shipbob','feed')),
  partner text NOT NULL CHECK (length(partner) BETWEEN 1 AND 150),
  tolerance numeric NOT NULL DEFAULT 0 CHECK (tolerance>=0),
  token_hash text UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[a-f0-9]{64}$'),
  token_issued_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,location_id)
);
CREATE UNIQUE INDEX agent_partner_locations_shipbob ON stockchief_runtime.agent_partner_locations(workspace_id) WHERE source='shipbob';
CREATE INDEX agent_partner_locations_location ON stockchief_runtime.agent_partner_locations(location_id);
CREATE INDEX agent_partner_locations_creator ON stockchief_runtime.agent_partner_locations(created_by);

CREATE TABLE stockchief_runtime.agent_partner_stock_reports (
  workspace_id text NOT NULL,
  id text NOT NULL,
  location_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('shipbob','csv','api')),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 200),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  complete boolean NOT NULL DEFAULT false,
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines)='array'),
  submitted_by text REFERENCES users(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,location_id,request_key),
  FOREIGN KEY(workspace_id,location_id) REFERENCES stockchief_runtime.agent_partner_locations(workspace_id,location_id) ON DELETE CASCADE
);
CREATE INDEX agent_partner_stock_reports_recent ON stockchief_runtime.agent_partner_stock_reports(workspace_id,location_id,received_at DESC);
CREATE INDEX agent_partner_stock_reports_submitter ON stockchief_runtime.agent_partner_stock_reports(submitted_by) WHERE submitted_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_partner_stock_positions (
  workspace_id text NOT NULL,
  location_id text NOT NULL,
  sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  report_id text NOT NULL,
  reported numeric NOT NULL,
  available numeric,
  expected numeric NOT NULL,
  observed_at timestamptz NOT NULL,
  compared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL CHECK (status IN ('AGREES','DIFFERS','EXPLAINED')),
  explained_by text REFERENCES users(id) ON DELETE SET NULL,
  explained_note text CHECK (explained_note IS NULL OR length(explained_note)<=1000),
  explained_at timestamptz,
  PRIMARY KEY(workspace_id,location_id,sku_id),
  FOREIGN KEY(workspace_id,location_id) REFERENCES stockchief_runtime.agent_partner_locations(workspace_id,location_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,report_id) REFERENCES stockchief_runtime.agent_partner_stock_reports(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX agent_partner_stock_positions_sku ON stockchief_runtime.agent_partner_stock_positions(workspace_id,sku_id);
CREATE INDEX agent_partner_stock_positions_open ON stockchief_runtime.agent_partner_stock_positions(workspace_id,observed_at DESC) WHERE status='DIFFERS';
CREATE INDEX agent_partner_stock_positions_report ON stockchief_runtime.agent_partner_stock_positions(workspace_id,report_id);
CREATE INDEX agent_partner_stock_positions_explainer ON stockchief_runtime.agent_partner_stock_positions(explained_by) WHERE explained_by IS NOT NULL;
CREATE INDEX agent_partner_stock_positions_sku_ref ON stockchief_runtime.agent_partner_stock_positions(sku_id);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_partner_locations'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_partner_stock_reports'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_partner_stock_positions'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_partner_locations'::regclass,'stockchief_runtime.agent_partner_stock_reports'::regclass,
 'stockchief_runtime.agent_partner_stock_positions'::regclass);
