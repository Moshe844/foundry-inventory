CREATE TABLE stockchief_runtime.agent_automation_opportunities (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 month text NOT NULL CHECK(month ~ '^[0-9]{4}-[0-9]{2}$'),
 rows jsonb NOT NULL CHECK(jsonb_typeof(rows)='array'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,month)
);
ALTER TABLE stockchief_runtime.agent_operational_notices DROP CONSTRAINT agent_operational_notices_job_id_check;
ALTER TABLE stockchief_runtime.agent_operational_notices ADD CHECK(job_id IN (124,167,168,169,170,171,206));
INSERT INTO commercial_storage_tables(relation,bytes_expression)
VALUES('stockchief_runtime.agent_automation_opportunities'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
SELECT id,'stockchief_runtime.agent_automation_opportunities'::regclass,true FROM workspaces
ON CONFLICT DO NOTHING;
