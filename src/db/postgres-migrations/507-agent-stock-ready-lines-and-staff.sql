-- Job 50 (Growth draft, Pro and Custom alone): tell sales and customers when a
-- waited-for item is back in stock.
--
-- One row per order line that waited and now has its stock reserved, so each
-- line is told about once: the customer notice that covered it, and the people
-- who handle that customer (the salesperson who entered the order, else the
-- people who enter this customer's orders, else whoever manages sales orders).
CREATE TABLE stockchief_runtime.agent_stock_ready_lines (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sales_order_line_id text NOT NULL REFERENCES sales_order_lines(id) ON DELETE CASCADE,
  sales_order_id text NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  quantity numeric NOT NULL,
  ready_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  communication_id text REFERENCES customer_communications(id) ON DELETE SET NULL,
  noticed_at timestamptz,
  PRIMARY KEY (workspace_id,sales_order_line_id)
);
CREATE INDEX agent_stock_ready_lines_line ON stockchief_runtime.agent_stock_ready_lines(sales_order_line_id);
CREATE INDEX agent_stock_ready_lines_order ON stockchief_runtime.agent_stock_ready_lines(sales_order_id);
CREATE INDEX agent_stock_ready_lines_message ON stockchief_runtime.agent_stock_ready_lines(communication_id) WHERE communication_id IS NOT NULL;

-- Each person told about one line, once. Needs you shows it until they mark it
-- seen or the line is no longer waiting to ship. The batches record the email,
-- text and push it went out in (jobs 166 to 175).
CREATE TABLE stockchief_runtime.agent_stock_ready_staff (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  sales_order_line_id text NOT NULL,
  sales_order_id text NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('salesperson','customer','sales')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  seen_at timestamptz,
  seen_by text REFERENCES users(id) ON DELETE SET NULL,
  cleared_at timestamptz,
  email_batch text,
  email_communication_id text,
  sms_batch text,
  push_batch text,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,sales_order_line_id,user_id),
  FOREIGN KEY (workspace_id,sales_order_line_id) REFERENCES stockchief_runtime.agent_stock_ready_lines(workspace_id,sales_order_line_id) ON DELETE CASCADE
);
CREATE INDEX agent_stock_ready_staff_open ON stockchief_runtime.agent_stock_ready_staff(workspace_id,user_id,created_at) WHERE seen_at IS NULL AND cleared_at IS NULL;
CREATE INDEX agent_stock_ready_staff_order ON stockchief_runtime.agent_stock_ready_staff(sales_order_id);
CREATE INDEX agent_stock_ready_staff_person ON stockchief_runtime.agent_stock_ready_staff(user_id);
CREATE INDEX agent_stock_ready_staff_seen_by ON stockchief_runtime.agent_stock_ready_staff(seen_by) WHERE seen_by IS NOT NULL;

-- Lines a stock-ready update already covered: every line of its order.
INSERT INTO stockchief_runtime.agent_stock_ready_lines(workspace_id,sales_order_line_id,sales_order_id,quantity,ready_at,communication_id,noticed_at)
  SELECT DISTINCT ON (l.id) m.workspace_id,l.id,l.sales_order_id,l.quantity_ordered,m.created_at::timestamptz,m.id,m.created_at::timestamptz
  FROM customer_communications m JOIN sales_order_lines l ON l.workspace_id=m.workspace_id AND l.sales_order_id=m.stock_ready_order_id
  WHERE m.stock_ready_order_id IS NOT NULL ORDER BY l.id,m.created_at DESC;

-- Job 50 joins whatever job list the alert channel settings allow by now.
DO $$
DECLARE allowed text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO allowed FROM pg_constraint
  WHERE conname='agent_alert_channels_job_id_check' AND conrelid='stockchief_runtime.agent_alert_channels'::regclass;
 IF allowed IS NULL OR position('ARRAY[' IN allowed)=0 THEN
  RAISE EXCEPTION 'The job list on stockchief_runtime.agent_alert_channels has an unexpected form.';
 END IF;
 IF allowed !~ '\m50\M' THEN
  EXECUTE 'ALTER TABLE stockchief_runtime.agent_alert_channels DROP CONSTRAINT agent_alert_channels_job_id_check, ADD CONSTRAINT agent_alert_channels_job_id_check '||replace(allowed,'ARRAY[','ARRAY[50, ');
 END IF;
END $$;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_stock_ready_lines'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_stock_ready_staff'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY[
    'stockchief_runtime.agent_stock_ready_lines'::regclass,
    'stockchief_runtime.agent_stock_ready_staff'::regclass]) r;
