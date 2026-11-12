-- Job 52: customer orders read from emails, PDFs and spreadsheets.

-- A customer's own code for one of our products, as they write it on orders.
CREATE TABLE stockchief_runtime.agent_customer_item_codes (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 80),
  code_key text NOT NULL CHECK (code_key=lower(code)),
  sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,customer_id,code_key)
);
CREATE INDEX agent_customer_item_code_customer ON stockchief_runtime.agent_customer_item_codes(customer_id);
CREATE INDEX agent_customer_item_code_sku ON stockchief_runtime.agent_customer_item_codes(sku_id);
CREATE INDEX agent_customer_item_code_owner ON stockchief_runtime.agent_customer_item_codes(created_by) WHERE created_by IS NOT NULL;

-- The owner's limits for customer orders StockChief creates and confirms on its
-- own (jobs 52 and 53). Counted as one taught rule while it is on.
CREATE TABLE stockchief_runtime.agent_customer_order_limits (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  maximum_minor bigint NOT NULL CHECK (maximum_minor>0),
  maximum_units numeric NOT NULL CHECK (maximum_units>0),
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  revision int NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_customer_order_limit_owner ON stockchief_runtime.agent_customer_order_limits(authorized_by) WHERE authorized_by IS NOT NULL;

-- What StockChief did with each customer order email.
CREATE TABLE stockchief_runtime.agent_customer_email_orders (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES connection_email_messages(id) ON DELETE CASCADE,
  customer_id text REFERENCES customers(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('HELD','WATCHED','DRAFTED','CONFIRMED','UNDONE')),
  reason text,
  sales_order_id text REFERENCES sales_orders(id) ON DELETE SET NULL,
  automatic boolean NOT NULL DEFAULT false,
  total_minor bigint,
  currency text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,message_id),
  CHECK (status NOT IN ('DRAFTED','CONFIRMED','UNDONE') OR sales_order_id IS NOT NULL)
);
CREATE INDEX agent_customer_email_order_waiting ON stockchief_runtime.agent_customer_email_orders(workspace_id,updated_at)
  WHERE status IN ('HELD','WATCHED','DRAFTED');
CREATE INDEX agent_customer_email_order_recent ON stockchief_runtime.agent_customer_email_orders(workspace_id,updated_at DESC,message_id);
CREATE INDEX agent_customer_email_order_message ON stockchief_runtime.agent_customer_email_orders(message_id);
CREATE INDEX agent_customer_email_order_customer ON stockchief_runtime.agent_customer_email_orders(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX agent_customer_email_order_order ON stockchief_runtime.agent_customer_email_orders(sales_order_id) WHERE sales_order_id IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_customer_item_codes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_customer_order_limits'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_customer_email_orders'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation IN ('stockchief_runtime.agent_customer_item_codes'::regclass,'stockchief_runtime.agent_customer_order_limits'::regclass,
    'stockchief_runtime.agent_customer_email_orders'::regclass);
