CREATE TABLE stockchief_runtime.agent_sop_sources (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  uploaded_by text NOT NULL,
  job_id text NOT NULL,
  filename text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  content bytea NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','READING','READY','FAILED','RETIRED')),
  reading jsonb,
  problem text,
  credits_used integer NOT NULL DEFAULT 0 CHECK (credits_used >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,source_hash),
  UNIQUE (workspace_id,job_id)
);

CREATE TABLE stockchief_runtime.agent_sop_proposals (
  workspace_id text NOT NULL,
  source_id text NOT NULL,
  proposal_id text NOT NULL REFERENCES operating_instruction_proposals(id) ON DELETE CASCADE,
  quote_id text NOT NULL,
  source_hash text NOT NULL,
  PRIMARY KEY (workspace_id,proposal_id),
  FOREIGN KEY (workspace_id,source_id) REFERENCES stockchief_runtime.agent_sop_sources(workspace_id,id) ON DELETE CASCADE,
  UNIQUE (workspace_id,source_id,quote_id)
);

CREATE INDEX agent_sop_recent ON stockchief_runtime.agent_sop_sources(workspace_id,created_at DESC,id DESC);

ALTER TABLE operating_instruction_proposals ADD COLUMN sop_source jsonb;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_sop_sources'::regclass,'octet_length(t.content)+octet_length(convert_to((to_jsonb(t)-''content'')::text,''UTF8''))'),
 ('stockchief_runtime.agent_sop_proposals'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_sop_sources'::regclass,
  'stockchief_runtime.agent_sop_proposals'::regclass])r;
