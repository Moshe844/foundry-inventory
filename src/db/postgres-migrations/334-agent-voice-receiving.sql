INSERT INTO commercial_cost_rates(id,provider,operation,unit,cost_per_unit_minor,currency,
 effective_from,source,model,provider_version,pricing_basis,confidence)
VALUES('openai-gpt-transcribe-public-duration-20261110','openai','audio_transcription','second',0.0075,'USD',
 '2026-11-10T00:00:00Z','https://developers.openai.com/api/docs/pricing#transcription-and-speech (reviewed 2026-11-10)',
 'gpt-transcribe','audio-2026-08-26','CONSERVATIVE_ESTIMATE','MEDIUM');

CREATE TABLE stockchief_runtime.agent_voice_receiving_notes (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  uploaded_by text NOT NULL,
  purchase_order_id text NOT NULL,
  job_id text NOT NULL,
  filename text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  content bytea NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','READING','READY','FAILED')),
  transcript text,
  draft jsonb,
  problem text,
  credits_used integer NOT NULL DEFAULT 0 CHECK (credits_used>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,purchase_order_id,source_hash),
  UNIQUE(workspace_id,job_id)
);
CREATE INDEX agent_voice_notes_recent ON stockchief_runtime.agent_voice_receiving_notes(workspace_id,created_at DESC,id DESC);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_voice_receiving_notes'::regclass,
  'octet_length(t.content)+octet_length(convert_to((to_jsonb(t)-''content'')::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_voice_receiving_notes'::regclass,true FROM workspaces;
