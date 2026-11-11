CREATE TABLE stockchief_runtime.agent_delivery_comparisons (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 id text NOT NULL,
 purchase_order_id text NOT NULL REFERENCES purchase_orders(id),
 request_key text NOT NULL,
 request_hash text NOT NULL,
 recorded_by text NOT NULL,
 source_reference text NOT NULL,
 source_hash text NOT NULL,
 source_snapshot jsonb NOT NULL,
 result jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,request_key)
);
CREATE INDEX agent_delivery_comparison_order ON stockchief_runtime.agent_delivery_comparisons(workspace_id,purchase_order_id,recorded_at DESC,id DESC);
CREATE INDEX agent_delivery_comparison_history ON stockchief_runtime.agent_delivery_comparisons(workspace_id,recorded_at DESC,id DESC);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_delivery_comparisons'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_delivery_comparisons'::regclass,true FROM workspaces;
