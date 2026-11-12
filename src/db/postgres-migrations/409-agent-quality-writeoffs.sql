-- An owner-approved write-off of goods that failed delivery QC. Each row is
-- one stock removal through the ordinary damaged-stock path, with its exact
-- batch, serial units and measured weight, and replays by its request key.
CREATE TABLE stockchief_runtime.agent_quality_writeoffs (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 hold_id text NOT NULL REFERENCES stockchief_runtime.agent_quality_holds(id),
 request_key text NOT NULL,
 quantity numeric(20,6) NOT NULL CHECK(quantity>0),
 secondary_quantity numeric(20,6) CHECK(secondary_quantity>0),
 serial_unit_ids text[] NOT NULL DEFAULT '{}',
 movement_id text NOT NULL,
 journal_entry_id text,
 value_minor bigint NOT NULL DEFAULT 0 CHECK(value_minor>=0),
 note text NOT NULL CHECK(length(note) BETWEEN 1 AND 1000),
 approved_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,request_key)
);
CREATE INDEX agent_quality_writeoff_hold ON stockchief_runtime.agent_quality_writeoffs(hold_id);
CREATE INDEX agent_quality_writeoff_approver ON stockchief_runtime.agent_quality_writeoffs(approved_by);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_quality_writeoffs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_quality_writeoffs'::regclass,true FROM workspaces;
