CREATE TABLE stockchief_runtime.agent_partner_stock_settings (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 actor_id text NOT NULL REFERENCES users(id),
 connector_id text NOT NULL REFERENCES workspace_connectors(id),
 enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 retry_after timestamptz NOT NULL DEFAULT now(),
 last_issue text,
 last_issue_sku text REFERENCES skus(id)
);
CREATE INDEX shipbob_stock_due_reads ON stockchief_runtime.shipbob_sandbox_stock(observed_at,workspace_id,sku_id);
CREATE INDEX agent_partner_stock_owner ON stockchief_runtime.agent_partner_stock_settings(actor_id);
CREATE INDEX agent_partner_stock_connector ON stockchief_runtime.agent_partner_stock_settings(connector_id);
CREATE INDEX agent_partner_stock_issue_sku ON stockchief_runtime.agent_partner_stock_settings(last_issue_sku) WHERE last_issue_sku IS NOT NULL;
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_partner_stock_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_partner_stock_settings'::regclass,true FROM workspaces;
