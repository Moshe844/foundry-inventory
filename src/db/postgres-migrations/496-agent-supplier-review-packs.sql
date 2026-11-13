-- Job 164 (Pro and Custom): the quarterly supplier review pack.
-- After each calendar quarter StockChief prepares one pack for every active
-- supplier with orders placed in that quarter, keeps the PDF it made, and
-- sends it to the supplier from the owner's connected mailbox. One pack per
-- supplier and quarter, so a replay never sends twice.

CREATE TABLE stockchief_runtime.agent_supplier_review_packs (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  supplier_id text NOT NULL REFERENCES suppliers(id),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(03|06|09|12)$'),
  quarter_start text NOT NULL CHECK (quarter_start ~ '^[0-9]{4}-[0-9]{2}-01$'),
  quarter_end text NOT NULL CHECK (quarter_end ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  supplier_name text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  summary jsonb NOT NULL,
  file bytea NOT NULL CHECK (octet_length(file) BETWEEN 1 AND 16777216),
  filename text NOT NULL CHECK (filename ~ '^[-a-zA-Z0-9_.]{1,120}$'),
  -- WATCHED: kept while StockChief only watches. WAITING: the owner presses send.
  -- STOPPED: a fact is missing (reason). QUEUED: handed to the mailbox; the
  -- message itself records whether it was sent.
  status text NOT NULL CHECK (status IN ('WATCHED','WAITING','STOPPED','QUEUED')),
  reason text,
  problem text CHECK (problem IS NULL OR problem IN ('recipient','mailbox','mailbox_choice','size')),
  authorization_kind text CHECK (authorization_kind IS NULL OR authorization_kind IN ('AUTOMATIC','INDIVIDUAL')),
  recipient text,
  connector_id text,
  communication_id text,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt>=0),
  sent_by text REFERENCES users(id) ON DELETE SET NULL,
  queued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,supplier_id,period),
  CHECK (status<>'QUEUED' OR (communication_id IS NOT NULL AND recipient IS NOT NULL AND connector_id IS NOT NULL AND authorization_kind IS NOT NULL)),
  CHECK (status<>'STOPPED' OR (reason IS NOT NULL AND problem IS NOT NULL))
);
CREATE INDEX agent_supplier_review_pack_period ON stockchief_runtime.agent_supplier_review_packs(workspace_id,period,status);
CREATE INDEX agent_supplier_review_pack_supplier ON stockchief_runtime.agent_supplier_review_packs(supplier_id);
CREATE INDEX agent_supplier_review_pack_sender ON stockchief_runtime.agent_supplier_review_packs(sent_by);

-- The owner's sending mailbox when more than one is connected.
CREATE TABLE stockchief_runtime.agent_supplier_review_settings (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_supplier_review_setting_owner ON stockchief_runtime.agent_supplier_review_settings(updated_by);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_supplier_review_packs'::regclass,'octet_length(t.file)+octet_length(t.summary::text)+512'),
  ('stockchief_runtime.agent_supplier_review_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY[
    'stockchief_runtime.agent_supplier_review_packs'::regclass,
    'stockchief_runtime.agent_supplier_review_settings'::regclass]) r;
