-- Job 57: the owner's wave rule for each warehouse (most orders in one wave,
-- the latest time of day StockChief starts a wave on its own) and every pick
-- wave StockChief built from released orders, grouped by zone and pick path.
CREATE TABLE stockchief_runtime.agent_pick_wave_rules (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
 wave_orders integer NOT NULL CHECK(wave_orders BETWEEN 1 AND 200),
 start_cutoff text CHECK(start_cutoff IS NULL OR start_cutoff ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 automatic boolean NOT NULL DEFAULT false,
 enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 authorized_by text REFERENCES users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,location_id)
);
CREATE INDEX agent_pick_wave_rule_location ON stockchief_runtime.agent_pick_wave_rules(location_id);
CREATE INDEX agent_pick_wave_rule_owner ON stockchief_runtime.agent_pick_wave_rules(authorized_by) WHERE authorized_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_pick_waves (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
 wave_id text NOT NULL REFERENCES fulfillment_waves(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('PREPARED','STARTED','UNDONE')),
 started_kind text CHECK(started_kind IN ('INDIVIDUAL','AUTOMATIC')),
 plan jsonb NOT NULL,
 rule_revision integer,
 reason text,
 prepared_by text REFERENCES users(id) ON DELETE SET NULL,
 started_by text REFERENCES users(id) ON DELETE SET NULL,
 started_at timestamptz,
 undone_by text REFERENCES users(id) ON DELETE SET NULL,
 undone_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,wave_id),
 CHECK((started_at IS NOT NULL)=(started_kind IS NOT NULL)),
 CHECK(status<>'STARTED' OR started_at IS NOT NULL),
 CHECK((status='UNDONE')=(undone_at IS NOT NULL))
);
CREATE INDEX agent_pick_wave_native ON stockchief_runtime.agent_pick_waves(wave_id);
CREATE INDEX agent_pick_wave_site ON stockchief_runtime.agent_pick_waves(location_id);
CREATE INDEX agent_pick_wave_waiting ON stockchief_runtime.agent_pick_waves(workspace_id,created_at) WHERE status='PREPARED';
CREATE INDEX agent_pick_wave_recent ON stockchief_runtime.agent_pick_waves(workspace_id,created_at DESC,id);
CREATE INDEX agent_pick_wave_preparer ON stockchief_runtime.agent_pick_waves(prepared_by) WHERE prepared_by IS NOT NULL;
CREATE INDEX agent_pick_wave_starter ON stockchief_runtime.agent_pick_waves(started_by) WHERE started_by IS NOT NULL;
CREATE INDEX agent_pick_wave_undoer ON stockchief_runtime.agent_pick_waves(undone_by) WHERE undone_by IS NOT NULL;

-- Waves waiting for a person to start appear in Needs you as soon as they change.
CREATE TRIGGER read_model_insert AFTER INSERT ON stockchief_runtime.agent_pick_waves REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
CREATE TRIGGER read_model_update AFTER UPDATE ON stockchief_runtime.agent_pick_waves REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
CREATE TRIGGER read_model_delete AFTER DELETE ON stockchief_runtime.agent_pick_waves REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_pick_wave_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_pick_waves'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_pick_wave_rules'::regclass,'stockchief_runtime.agent_pick_waves'::regclass);
