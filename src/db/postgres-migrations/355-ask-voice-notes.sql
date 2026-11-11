-- Ask voice notes read by the worker, when the web service itself has no
-- transcription key (src/assistant/ask-voice.js). The recording is kept only
-- until it is read: the audio is cleared as soon as the words come back, and
-- rows are removed after a day.
CREATE TABLE IF NOT EXISTS stockchief_runtime.ask_voice_notes (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  actor_user_id text NOT NULL,
  job_id text NOT NULL,
  usage_key text NOT NULL DEFAULT '',
  content bytea,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','READY','FAILED')),
  transcript text,
  problem text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,job_id)
);
CREATE INDEX IF NOT EXISTS ask_voice_notes_created ON stockchief_runtime.ask_voice_notes(workspace_id,created_at);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.ask_voice_notes'::regclass,
  'coalesce(octet_length(t.content),0)+octet_length(convert_to((to_jsonb(t)-''content'')::text,''UTF8''))');
