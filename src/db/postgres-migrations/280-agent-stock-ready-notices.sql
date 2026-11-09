CREATE TABLE stockchief_runtime.agent_stock_ready_settings (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 connector_id text NOT NULL REFERENCES workspace_connectors(id),
 mailbox_account text NOT NULL,
 provider_type text NOT NULL CHECK(provider_type IN ('gmail','microsoft365')),
 authorized_by text NOT NULL REFERENCES users(id),
 enabled boolean NOT NULL DEFAULT false,
 enabled_at timestamptz NOT NULL DEFAULT now(),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE INDEX agent_stock_ready_settings_connector ON stockchief_runtime.agent_stock_ready_settings(connector_id);
CREATE INDEX agent_stock_ready_settings_owner ON stockchief_runtime.agent_stock_ready_settings(authorized_by);
CREATE TABLE stockchief_runtime.agent_stock_ready_checks (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sales_order_id text NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
 checked_at timestamptz NOT NULL DEFAULT now(),
 retry_after timestamptz NOT NULL DEFAULT now(),
 problem text,
 PRIMARY KEY(workspace_id,sales_order_id)
);
CREATE INDEX agent_stock_ready_checks_order ON stockchief_runtime.agent_stock_ready_checks(sales_order_id);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_stock_ready_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_stock_ready_checks'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_stock_ready_settings'::regclass,'stockchief_runtime.agent_stock_ready_checks'::regclass]) r;
ALTER TABLE customer_communications ADD COLUMN stock_ready_order_id text REFERENCES sales_orders(id);
CREATE INDEX stock_ready_communication_order ON customer_communications(workspace_id,stock_ready_order_id) WHERE stock_ready_order_id IS NOT NULL;
CREATE INDEX stock_ready_communication_order_reference ON customer_communications(stock_ready_order_id) WHERE stock_ready_order_id IS NOT NULL;
CREATE INDEX stock_ready_order_events ON sales_order_events(workspace_id,sales_order_id,event_type,created_at);
CREATE INDEX stock_ready_confirm_events ON sales_order_events(workspace_id,event_type,created_at,sales_order_id);
ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase','customer-receipt','customer-reminder','arrived-stock','stock-ready'));
ALTER TABLE stockchief_runtime.agent_operational_notices DROP CONSTRAINT agent_operational_notices_job_id_check;
ALTER TABLE stockchief_runtime.agent_operational_notices ADD CHECK(job_id IN (50,67,87,124,167,168,169,170,171,204,206,209));
