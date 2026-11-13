-- Job 141: the paperwork from a voice note ("3 boxes of X just came in"): a
-- receipt, a count, a transfer or a stock correction.

-- Each recorded note, its transcript, the paperwork StockChief prepared from it
-- and what became of it.
CREATE TABLE stockchief_runtime.agent_voice_paperwork (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  uploaded_by text NOT NULL,
  job_id text NOT NULL,
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 180),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  content bytea NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','READING','READY','FAILED')),
  transcript text,
  kind text CHECK (kind IN ('RECEIPT','COUNT','TRANSFER','ADJUSTMENT')),
  draft jsonb,
  status text NOT NULL DEFAULT 'READING' CHECK (status IN ('READING','REVIEW','DRAFT','POSTED','STOPPED','FAILED')),
  reason text,
  automatic boolean NOT NULL DEFAULT false,
  result jsonb,
  decided_by text,
  decided_at timestamptz,
  problem text,
  credits_used integer NOT NULL DEFAULT 0 CHECK (credits_used>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,source_hash),
  UNIQUE (workspace_id,job_id)
);
CREATE INDEX agent_voice_paperwork_recent ON stockchief_runtime.agent_voice_paperwork(workspace_id,created_at DESC,id DESC);
CREATE INDEX agent_voice_paperwork_waiting ON stockchief_runtime.agent_voice_paperwork(workspace_id,updated_at)
  WHERE status IN ('REVIEW','DRAFT');

-- The owner's limits for paperwork StockChief posts on its own: the most units
-- one line may change and the most stock value one note may move. Counted as
-- one taught rule while it is on.
CREATE TABLE stockchief_runtime.agent_voice_paperwork_limits (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  maximum_units numeric NOT NULL CHECK (maximum_units>0),
  maximum_minor bigint NOT NULL CHECK (maximum_minor>0),
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  revision int NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_voice_paperwork_limit_owner ON stockchief_runtime.agent_voice_paperwork_limits(authorized_by) WHERE authorized_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_voice_paperwork'::regclass,
   'octet_length(t.content)+octet_length(convert_to((to_jsonb(t)-''content'')::text,''UTF8''))'),
  ('stockchief_runtime.agent_voice_paperwork_limits'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation IN ('stockchief_runtime.agent_voice_paperwork'::regclass,'stockchief_runtime.agent_voice_paperwork_limits'::regclass);
