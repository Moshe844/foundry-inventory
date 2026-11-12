-- Customer account mail: job 81 (statements sent when a customer asks) and
-- job 102 (payment reminders on the owner's schedule). One migration serves
-- both because they share the customer mailbox paths.

-- Job 81: one row per request for an account statement, from a customer's
-- email, from a person in Ask, or from a sender who is not a customer. It says
-- what StockChief did and why it stopped when it did.
CREATE TABLE stockchief_runtime.agent_statement_requests (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  source text NOT NULL CHECK (source IN ('email','ask','unknown_sender')),
  message_id text REFERENCES connection_email_messages(id) ON DELETE CASCADE,
  set_aside_id text REFERENCES connection_email_set_aside(id) ON DELETE CASCADE,
  sender text,
  subject text,
  customer_id text REFERENCES customers(id) ON DELETE SET NULL,
  currency text,
  status text NOT NULL CHECK (status IN ('HELD','WATCHED','DRAFTED','QUEUED','DISMISSED')),
  reason text,
  proposal_id text,
  communication_id text REFERENCES customer_communications(id) ON DELETE SET NULL,
  automatic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  CHECK (source<>'email' OR message_id IS NOT NULL),
  CHECK (source<>'unknown_sender' OR set_aside_id IS NOT NULL),
  CHECK (status<>'QUEUED' OR communication_id IS NOT NULL)
);
CREATE UNIQUE INDEX agent_statement_request_message ON stockchief_runtime.agent_statement_requests(workspace_id,message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX agent_statement_request_aside ON stockchief_runtime.agent_statement_requests(workspace_id,set_aside_id) WHERE set_aside_id IS NOT NULL;
CREATE INDEX agent_statement_request_message_ref ON stockchief_runtime.agent_statement_requests(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX agent_statement_request_aside_ref ON stockchief_runtime.agent_statement_requests(set_aside_id) WHERE set_aside_id IS NOT NULL;
CREATE INDEX agent_statement_request_customer ON stockchief_runtime.agent_statement_requests(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX agent_statement_request_communication ON stockchief_runtime.agent_statement_requests(communication_id) WHERE communication_id IS NOT NULL;
CREATE INDEX agent_statement_request_waiting ON stockchief_runtime.agent_statement_requests(workspace_id,updated_at) WHERE status IN ('HELD','WATCHED');
CREATE INDEX agent_statement_request_recent ON stockchief_runtime.agent_statement_requests(workspace_id,updated_at DESC,id);

-- Job 102: a schedule can remind before the due date (negative days), on it
-- (zero) and after it, and each step can carry the owner's own wording.
ALTER TABLE stockchief_runtime.agent_invoice_reminder_rules DROP CONSTRAINT agent_invoice_reminder_rules_days_after_due_check;
ALTER TABLE stockchief_runtime.agent_invoice_reminder_rules ADD CONSTRAINT agent_invoice_reminder_rules_days_after_due_check
  CHECK (cardinality(days_after_due) BETWEEN 1 AND 12 AND -60<=ALL(days_after_due) AND 365>=ALL(days_after_due) AND array_position(days_after_due,NULL) IS NULL);
ALTER TABLE stockchief_runtime.agent_invoice_reminder_rules ADD COLUMN templates jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(templates)='object');

-- Job 102: a customer disputing an invoice (or saying it is already paid)
-- stops its reminders until a person settles the question.
CREATE TABLE stockchief_runtime.agent_customer_invoice_disputes (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  invoice_id text NOT NULL REFERENCES accounting_customer_invoices(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('email','owner')),
  message_id text REFERENCES connection_email_messages(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  opened_by text REFERENCES users(id) ON DELETE SET NULL,
  resolved_by text REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  CHECK ((status='RESOLVED')=(resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX agent_customer_invoice_dispute_open ON stockchief_runtime.agent_customer_invoice_disputes(workspace_id,invoice_id) WHERE status='OPEN';
CREATE UNIQUE INDEX agent_customer_invoice_dispute_email ON stockchief_runtime.agent_customer_invoice_disputes(workspace_id,message_id,invoice_id) WHERE message_id IS NOT NULL;
CREATE INDEX agent_customer_invoice_dispute_invoice ON stockchief_runtime.agent_customer_invoice_disputes(invoice_id);
CREATE INDEX agent_customer_invoice_dispute_customer ON stockchief_runtime.agent_customer_invoice_disputes(customer_id);
CREATE INDEX agent_customer_invoice_dispute_message ON stockchief_runtime.agent_customer_invoice_disputes(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX agent_customer_invoice_dispute_opened_by ON stockchief_runtime.agent_customer_invoice_disputes(opened_by) WHERE opened_by IS NOT NULL;
CREATE INDEX agent_customer_invoice_dispute_resolved_by ON stockchief_runtime.agent_customer_invoice_disputes(resolved_by) WHERE resolved_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_statement_requests'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_customer_invoice_disputes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY[
    'stockchief_runtime.agent_statement_requests'::regclass,
    'stockchief_runtime.agent_customer_invoice_disputes'::regclass]) r;
