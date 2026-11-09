CREATE TABLE stockchief_runtime.agent_arrived_stock_checks (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sales_order_id text NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
 checked_at timestamptz NOT NULL DEFAULT now(),
 retry_after timestamptz NOT NULL DEFAULT now(),
 problem text,
 PRIMARY KEY(workspace_id,sales_order_id)
);
CREATE INDEX agent_arrived_stock_checks_order ON stockchief_runtime.agent_arrived_stock_checks(sales_order_id);
INSERT INTO commercial_storage_tables(relation,bytes_expression)
 VALUES('stockchief_runtime.agent_arrived_stock_checks'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_arrived_stock_checks'::regclass,true FROM workspaces;
ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase','customer-receipt','customer-reminder','arrived-stock'));
