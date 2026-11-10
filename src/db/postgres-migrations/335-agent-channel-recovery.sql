CREATE TABLE stockchief_runtime.agent_channel_recovery_checks (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  effect_id text NOT NULL REFERENCES stockchief_runtime.provider_effects(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  checked_at timestamptz,
  outcome text NOT NULL DEFAULT 'QUEUED' CHECK (outcome IN ('QUEUED','VERIFIED','HELD')),
  PRIMARY KEY(workspace_id,effect_id)
);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_channel_recovery_checks'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_channel_recovery_checks'::regclass,true FROM workspaces;
