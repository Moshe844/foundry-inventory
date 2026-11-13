-- Job 83: customers order by text message (SMS) or WhatsApp.

-- The business's own number on each channel, on StockChief's text provider
-- account, and the private link the provider sends that number's messages to.
-- One number belongs to one inventory at a time.
CREATE TABLE stockchief_runtime.agent_text_order_lines (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('SMS','WHATSAPP')),
  number text NOT NULL CHECK (number ~ '^\+[1-9][0-9]{7,14}$'),
  endpoint text NOT NULL CHECK (endpoint ~ '^[A-Za-z0-9_-]{32}$'),
  enabled boolean NOT NULL DEFAULT true,
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  revision int NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (endpoint),
  UNIQUE (workspace_id,channel)
);
CREATE UNIQUE INDEX agent_text_order_line_number ON stockchief_runtime.agent_text_order_lines(channel,number) WHERE enabled;
CREATE INDEX agent_text_order_line_owner ON stockchief_runtime.agent_text_order_lines(authorized_by) WHERE authorized_by IS NOT NULL;

-- Each message a customer sent to a line, and what StockChief did with it.
CREATE TABLE stockchief_runtime.agent_customer_text_orders (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  line_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('SMS','WHATSAPP')),
  provider_reference text NOT NULL CHECK (length(provider_reference) BETWEEN 1 AND 120),
  sender text NOT NULL CHECK (sender ~ '^\+[1-9][0-9]{7,14}$'),
  body text NOT NULL CHECK (length(body)<=4000),
  media_count int NOT NULL DEFAULT 0 CHECK (media_count>=0),
  customer_id text REFERENCES customers(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','HELD','WATCHED','DRAFTED','CONFIRMED','UNDONE','STOPPED')),
  reason text,
  sales_order_id text REFERENCES sales_orders(id) ON DELETE SET NULL,
  automatic boolean NOT NULL DEFAULT false,
  total_minor bigint,
  currency text,
  reply_status text NOT NULL DEFAULT 'NONE' CHECK (reply_status IN ('NONE','SENDING','SENT','FAILED','UNCERTAIN')),
  reply_body text,
  reply_reference text,
  reply_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,channel,provider_reference),
  FOREIGN KEY (workspace_id,line_id) REFERENCES stockchief_runtime.agent_text_order_lines(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX agent_customer_text_order_line ON stockchief_runtime.agent_customer_text_orders(workspace_id,line_id);
CREATE INDEX agent_customer_text_order_waiting ON stockchief_runtime.agent_customer_text_orders(workspace_id,updated_at)
  WHERE status IN ('RECEIVED','HELD','WATCHED','DRAFTED');
CREATE INDEX agent_customer_text_order_recent ON stockchief_runtime.agent_customer_text_orders(workspace_id,updated_at DESC,id);
CREATE INDEX agent_customer_text_order_sender ON stockchief_runtime.agent_customer_text_orders(workspace_id,sender,created_at DESC);
CREATE INDEX agent_customer_text_order_customer ON stockchief_runtime.agent_customer_text_orders(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX agent_customer_text_order_order ON stockchief_runtime.agent_customer_text_orders(sales_order_id) WHERE sales_order_id IS NOT NULL;

-- Pro takes a customer's text orders on its own once taught: by this saved
-- rule, or by a text order from the customer that a person confirmed. A rule
-- the owner turned off means "always ask me" for that customer. Counted as a
-- taught rule while it is on.
CREATE TABLE stockchief_runtime.agent_text_order_rules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  enabled boolean NOT NULL,
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  revision int NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,customer_id)
);
CREATE INDEX agent_text_order_rule_customer ON stockchief_runtime.agent_text_order_rules(customer_id);
CREATE INDEX agent_text_order_rule_owner ON stockchief_runtime.agent_text_order_rules(authorized_by) WHERE authorized_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_text_order_lines'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_customer_text_orders'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_text_order_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation IN ('stockchief_runtime.agent_text_order_lines'::regclass,'stockchief_runtime.agent_customer_text_orders'::regclass,
    'stockchief_runtime.agent_text_order_rules'::regclass);
