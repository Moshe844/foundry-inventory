-- Job 165 (Growth, Pro and Custom): the year-end stocktake and valuation pack
-- for the accountant. The owner saves the month the financial year ends, the
-- accountant's email and (with several mailboxes) the one to send from. After
-- each year end StockChief makes the workbook, keeps it and sends it. One
-- pack per financial year, so a replay never sends twice.

CREATE TABLE stockchief_runtime.agent_year_end_settings (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  year_end_month smallint NOT NULL CHECK (year_end_month BETWEEN 1 AND 12),
  accountant_name text CHECK (accountant_name IS NULL OR length(accountant_name) BETWEEN 1 AND 120),
  accountant_email text CHECK (accountant_email IS NULL OR accountant_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  connector_id text,
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_year_end_setting_owner ON stockchief_runtime.agent_year_end_settings(authorized_by);

CREATE TABLE stockchief_runtime.agent_year_end_packs (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  closing text NOT NULL CHECK (closing ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  year_start text NOT NULL CHECK (year_start ~ '^[0-9]{4}-[0-9]{2}-01$'),
  year_end text NOT NULL CHECK (year_end ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
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
  made_by text REFERENCES users(id) ON DELETE SET NULL,
  queued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,closing),
  CHECK (status<>'QUEUED' OR (communication_id IS NOT NULL AND recipient IS NOT NULL AND connector_id IS NOT NULL AND authorization_kind IS NOT NULL)),
  CHECK (status<>'STOPPED' OR (reason IS NOT NULL AND problem IS NOT NULL))
);
CREATE INDEX agent_year_end_pack_sender ON stockchief_runtime.agent_year_end_packs(sent_by);
CREATE INDEX agent_year_end_pack_maker ON stockchief_runtime.agent_year_end_packs(made_by);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_year_end_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_year_end_packs'::regclass,'octet_length(t.file)+octet_length(t.summary::text)+512');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY[
    'stockchief_runtime.agent_year_end_settings'::regclass,
    'stockchief_runtime.agent_year_end_packs'::regclass]) r;
