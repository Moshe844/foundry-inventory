CREATE TABLE stockchief_runtime.agent_order_cost_facts (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,sales_order_id text NOT NULL REFERENCES sales_orders(id),
 currency text NOT NULL,channel text NOT NULL,fees_minor bigint NOT NULL,shipping_minor bigint NOT NULL,
 source_reference text NOT NULL,financial_hash text NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 confirmed_by text NOT NULL REFERENCES users(id),confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,sales_order_id)
);
CREATE INDEX agent_order_cost_order ON stockchief_runtime.agent_order_cost_facts(sales_order_id);
CREATE INDEX agent_order_cost_owner ON stockchief_runtime.agent_order_cost_facts(confirmed_by);
CREATE TABLE stockchief_runtime.agent_order_cost_previews (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 prepared_by text NOT NULL REFERENCES users(id),snapshot jsonb NOT NULL,status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','APPLIED','STOPPED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),applied_at timestamptz
);
CREATE INDEX agent_order_cost_preview_workspace ON stockchief_runtime.agent_order_cost_previews(workspace_id,created_at DESC);
CREATE INDEX agent_order_cost_preview_owner ON stockchief_runtime.agent_order_cost_previews(prepared_by);
CREATE INDEX IF NOT EXISTS agent_margin_entry_source ON accounting_journal_entries(workspace_id,source_record_type,source_record_id) WHERE status='POSTED';
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_order_cost_facts'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_order_cost_previews'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_order_cost_facts'::regclass,'stockchief_runtime.agent_order_cost_previews'::regclass])r;

CREATE INDEX agent_order_cost_preview_pending ON stockchief_runtime.agent_order_cost_previews(workspace_id,created_at) WHERE status='DRAFT';
