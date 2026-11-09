CREATE TABLE stockchief_runtime.channel_map_rules (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
 minimum_minor bigint NOT NULL CHECK(minimum_minor>0),
 currency text NOT NULL,
 authorized_by text NOT NULL REFERENCES users(id),
 revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,sku_id)
);
ALTER TABLE stockchief_runtime.agent_operational_notices DROP CONSTRAINT agent_operational_notices_job_id_check;
ALTER TABLE stockchief_runtime.agent_operational_notices ADD CHECK(job_id IN (67,87,124,167,168,169,170,171,206,209));
INSERT INTO commercial_storage_tables(relation,bytes_expression)
VALUES('stockchief_runtime.channel_map_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
SELECT id,'stockchief_runtime.channel_map_rules'::regclass,true FROM workspaces;
