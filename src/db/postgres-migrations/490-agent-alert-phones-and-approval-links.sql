-- Job 173: alerts by text message and push as well as email, chosen per kind
-- of alert. Job 175: approving from an email, a text or a push notification.

-- Each kind of alert and approvals waiting for a person (job 175) may also go
-- by text and push. Job 175 joins whatever job list the channel settings allow
-- by now, so jobs other migrations added (169, 170 to 172, 180) stay allowed.
DO $$
DECLARE allowed text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO allowed FROM pg_constraint
  WHERE conname='agent_alert_channels_job_id_check' AND conrelid='stockchief_runtime.agent_alert_channels'::regclass;
 IF allowed IS NULL OR position('ARRAY[' IN allowed)=0 THEN
  RAISE EXCEPTION 'The job list on stockchief_runtime.agent_alert_channels has an unexpected form.';
 END IF;
 IF allowed !~ '\m175\M' THEN
  EXECUTE 'ALTER TABLE stockchief_runtime.agent_alert_channels DROP CONSTRAINT agent_alert_channels_job_id_check, ADD CONSTRAINT agent_alert_channels_job_id_check '||replace(allowed,'ARRAY[','ARRAY[175, ');
 END IF;
END $$;
ALTER TABLE stockchief_runtime.agent_alert_channels
  ADD COLUMN sms boolean NOT NULL DEFAULT false,
  ADD COLUMN push boolean NOT NULL DEFAULT false,
  ADD COLUMN phone_note text CHECK (phone_note IS NULL OR length(phone_note)<=500);
ALTER TABLE stockchief_runtime.agent_alert_deliveries
  ADD COLUMN sms_batch text,
  ADD COLUMN push_batch text;
ALTER TABLE stockchief_runtime.agent_escalations
  ADD COLUMN sms_batch text,
  ADD COLUMN push_batch text;

-- One mobile number per person, used only once they confirm it with a code.
-- The code itself is never stored, only its hash.
CREATE TABLE stockchief_runtime.agent_alert_phones (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  verified_at timestamptz,
  code_hash text CHECK (code_hash IS NULL OR length(code_hash)=64),
  code_expires_at timestamptz,
  code_attempts integer NOT NULL DEFAULT 0 CHECK (code_attempts>=0),
  code_message_id text,
  codes_sent integer NOT NULL DEFAULT 0 CHECK (codes_sent>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,user_id)
);
CREATE INDEX agent_alert_phone_user ON stockchief_runtime.agent_alert_phones(user_id);

-- Browsers a person turned push on in. A device is switched off when its push
-- service says the browser dropped it.
CREATE TABLE stockchief_runtime.agent_push_devices (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL CHECK (length(endpoint)<=1000 AND endpoint LIKE 'https://%'),
  p256dh text NOT NULL CHECK (length(p256dh) BETWEEN 80 AND 100),
  auth text NOT NULL CHECK (length(auth) BETWEEN 16 AND 40),
  label text NOT NULL CHECK (length(label)<=100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_sent_at timestamptz,
  disabled_at timestamptz,
  disabled_reason text CHECK (disabled_reason IS NULL OR length(disabled_reason)<=300),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,user_id,endpoint)
);
CREATE INDEX agent_push_device_user ON stockchief_runtime.agent_push_devices(user_id);

-- Every text and push message, sent by the worker. Each is checked again just
-- before it goes out, and never sent twice.
CREATE TABLE stockchief_runtime.agent_alert_messages (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('SMS','PUSH')),
  purpose text NOT NULL CHECK (purpose IN ('ALERT','APPROVAL','CODE')),
  job_id smallint,
  batch text,
  manual boolean NOT NULL DEFAULT false,
  phone text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  device_id text,
  title text NOT NULL CHECK (length(title)<=200),
  body text NOT NULL CHECK (length(body)<=1000),
  url text CHECK (url IS NULL OR length(url)<=1000),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENDING','SENT','HELD','FAILED','UNCERTAIN')),
  provider_reference text CHECK (provider_reference IS NULL OR length(provider_reference)<=300),
  error text CHECK (error IS NULL OR length(error)<=500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  CHECK ((channel='SMS')=(phone IS NOT NULL)),
  CHECK ((channel='PUSH')=(device_id IS NOT NULL)),
  CHECK ((purpose='CODE')=(job_id IS NULL))
);
CREATE INDEX agent_alert_message_user ON stockchief_runtime.agent_alert_messages(workspace_id,user_id,created_at);
CREATE INDEX agent_alert_message_batch ON stockchief_runtime.agent_alert_messages(workspace_id,batch) WHERE batch IS NOT NULL;
CREATE INDEX agent_alert_message_person ON stockchief_runtime.agent_alert_messages(user_id) WHERE user_id IS NOT NULL;

-- One link per person and waiting approval. Opening it never approves; one
-- tap after sign-in does, once, if the approval is unchanged and still theirs.
CREATE TABLE stockchief_runtime.agent_approval_links (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{32,64}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key text NOT NULL CHECK (length(item_key)<=64),
  source_id text NOT NULL CHECK (length(source_id)<=300),
  href text NOT NULL CHECK (length(href)<=500),
  title text NOT NULL CHECK (length(title)<=300),
  revision text NOT NULL CHECK (length(revision)<=64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  opened_at timestamptz,
  closed_at timestamptz,
  claim_token text,
  claimed_at timestamptz,
  decided_at timestamptz,
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  outcome text CHECK (outcome IS NULL OR length(outcome)<=300),
  email_batch text,
  email_communication_id text,
  sms_batch text,
  push_batch text,
  UNIQUE (workspace_id,user_id,item_key),
  CHECK ((email_batch IS NULL)=(email_communication_id IS NULL))
);
CREATE INDEX agent_approval_link_open ON stockchief_runtime.agent_approval_links(workspace_id,user_id) WHERE decided_at IS NULL AND closed_at IS NULL;
CREATE INDEX agent_approval_link_person ON stockchief_runtime.agent_approval_links(user_id);
CREATE INDEX agent_approval_link_decider ON stockchief_runtime.agent_approval_links(decided_by) WHERE decided_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_alert_phones'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_push_devices'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_alert_messages'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_approval_links'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY[
    'stockchief_runtime.agent_alert_phones'::regclass,
    'stockchief_runtime.agent_push_devices'::regclass,
    'stockchief_runtime.agent_alert_messages'::regclass,
    'stockchief_runtime.agent_approval_links'::regclass]) r;
