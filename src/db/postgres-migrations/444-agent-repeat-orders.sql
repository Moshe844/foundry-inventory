-- Job 53: a customer's usual order repeated from one sentence, in Ask or in
-- the customer's own email. One row per request: what StockChief read the
-- sentence as, what it did, and whether a person approved the result.
CREATE TABLE stockchief_runtime.agent_repeat_orders (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  source text NOT NULL CHECK (source IN ('ask','email')),
  message_id text REFERENCES connection_email_messages(id) ON DELETE CASCADE,
  customer_id text REFERENCES customers(id) ON DELETE SET NULL,
  reading text,
  training_key text,
  status text NOT NULL CHECK (status IN ('HELD','WATCHED','DRAFTED','CONFIRMED','UNDONE')),
  reason text,
  sales_order_id text REFERENCES sales_orders(id) ON DELETE SET NULL,
  automatic boolean NOT NULL DEFAULT false,
  total_minor bigint,
  currency text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  CHECK (source<>'email' OR message_id IS NOT NULL),
  CHECK (status NOT IN ('DRAFTED','CONFIRMED','UNDONE') OR sales_order_id IS NOT NULL)
);
CREATE UNIQUE INDEX agent_repeat_order_message ON stockchief_runtime.agent_repeat_orders(workspace_id,message_id) WHERE message_id IS NOT NULL;
CREATE INDEX agent_repeat_order_message_ref ON stockchief_runtime.agent_repeat_orders(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX agent_repeat_order_customer ON stockchief_runtime.agent_repeat_orders(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX agent_repeat_order_order ON stockchief_runtime.agent_repeat_orders(sales_order_id) WHERE sales_order_id IS NOT NULL;
CREATE INDEX agent_repeat_order_examples ON stockchief_runtime.agent_repeat_orders(workspace_id,training_key) WHERE NOT automatic AND sales_order_id IS NOT NULL;
CREATE INDEX agent_repeat_order_waiting ON stockchief_runtime.agent_repeat_orders(workspace_id,updated_at) WHERE status IN ('HELD','WATCHED','DRAFTED');
CREATE INDEX agent_repeat_order_recent ON stockchief_runtime.agent_repeat_orders(workspace_id,updated_at DESC,id);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_repeat_orders'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation='stockchief_runtime.agent_repeat_orders'::regclass;
