CREATE TABLE stockchief_runtime.agent_pick_release_checks (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
 checked_at timestamptz NOT NULL DEFAULT now(),
 retry_after timestamptz NOT NULL DEFAULT now(),
 problem text,
 wave_id text REFERENCES fulfillment_waves(id),
 PRIMARY KEY(workspace_id,location_id)
);
CREATE INDEX agent_pick_release_location ON stockchief_runtime.agent_pick_release_checks(location_id);
CREATE INDEX agent_pick_release_wave ON stockchief_runtime.agent_pick_release_checks(wave_id) WHERE wave_id IS NOT NULL;
INSERT INTO commercial_storage_tables(relation,bytes_expression)
 VALUES('stockchief_runtime.agent_pick_release_checks'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_pick_release_checks'::regclass,true FROM workspaces;
