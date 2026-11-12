-- Job 159: the owner's schedule for the board or investor pack (Custom).
-- On or after the chosen day each month StockChief builds the pack for the
-- month that just ended. Built packs are kept as monthly report runs (457).

CREATE TABLE stockchief_runtime.agent_board_pack_schedules (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  day_of_month integer NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  enabled boolean NOT NULL DEFAULT true,
  authorized_by text NOT NULL REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_board_pack_schedule_owner ON stockchief_runtime.agent_board_pack_schedules(authorized_by);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_board_pack_schedules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.agent_board_pack_schedules'::regclass,true FROM workspaces;
