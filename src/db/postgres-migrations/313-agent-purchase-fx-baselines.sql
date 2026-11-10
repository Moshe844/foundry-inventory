CREATE TABLE stockchief_runtime.agent_purchase_fx_baselines (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 purchase_order_id text NOT NULL REFERENCES purchase_orders(id),base_currency text NOT NULL,
 base_per_foreign text NOT NULL,quoted_on date NOT NULL,source_reference text NOT NULL,source_hash text NOT NULL,
 confirmed_by text NOT NULL REFERENCES users(id),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(workspace_id,purchase_order_id)
);
CREATE INDEX agent_purchase_fx_order ON stockchief_runtime.agent_purchase_fx_baselines(purchase_order_id);
CREATE INDEX agent_purchase_fx_confirmer ON stockchief_runtime.agent_purchase_fx_baselines(confirmed_by);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_purchase_fx_baselines'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_purchase_fx_baselines'::regclass,true FROM workspaces;
