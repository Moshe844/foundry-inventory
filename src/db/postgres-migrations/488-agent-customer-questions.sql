-- Job 72: customer emails about stock, delivery dates and order status.
--
-- One row per customer email StockChief read as such a question. It keeps the
-- answer StockChief wrote from the records (or why it stopped), and what
-- happened to it: sent on its own, waiting for approval, watched only, or
-- stopped for a person.
CREATE TABLE stockchief_runtime.agent_customer_questions (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES connection_email_messages(id) ON DELETE CASCADE,
  customer_id text REFERENCES customers(id) ON DELETE SET NULL,
  sender text NOT NULL,
  subject text,
  topics text[] NOT NULL CHECK (topics <@ ARRAY['stock','delivery','status']::text[]),
  status text NOT NULL CHECK (status IN ('HELD','WATCHED','DRAFTED','QUEUED','SENT','DISMISSED')),
  reason text,
  answer_subject text,
  answer_body text,
  fingerprint text,
  communication_id text REFERENCES customer_communications(id) ON DELETE SET NULL,
  automatic boolean NOT NULL DEFAULT false,
  approved_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,message_id),
  CHECK (status NOT IN ('DRAFTED','QUEUED','SENT') OR (answer_body IS NOT NULL AND fingerprint IS NOT NULL AND customer_id IS NOT NULL)),
  CHECK (status NOT IN ('QUEUED','SENT') OR communication_id IS NOT NULL)
);
CREATE INDEX agent_customer_question_message ON stockchief_runtime.agent_customer_questions(message_id);
CREATE INDEX agent_customer_question_customer ON stockchief_runtime.agent_customer_questions(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX agent_customer_question_communication ON stockchief_runtime.agent_customer_questions(communication_id) WHERE communication_id IS NOT NULL;
CREATE INDEX agent_customer_question_approver ON stockchief_runtime.agent_customer_questions(approved_by) WHERE approved_by IS NOT NULL;
CREATE INDEX agent_customer_question_waiting ON stockchief_runtime.agent_customer_questions(workspace_id,updated_at) WHERE status IN ('HELD','WATCHED','DRAFTED','QUEUED');
CREATE INDEX agent_customer_question_recent ON stockchief_runtime.agent_customer_questions(workspace_id,updated_at DESC,message_id);

-- Growth: the owner teaches which questions StockChief may answer alone, for
-- one customer or every customer ("reply to customer stock questions
-- yourself"). Each rule counts against the plan's rule allowance.
CREATE TABLE stockchief_runtime.agent_customer_answer_rules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  customer_id text REFERENCES customers(id) ON DELETE CASCADE,
  topics text[] NOT NULL CHECK (cardinality(topics) BETWEEN 1 AND 3 AND topics <@ ARRAY['stock','delivery','status']::text[]),
  enabled boolean NOT NULL DEFAULT true,
  authorized_by text NOT NULL REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id)
);
CREATE UNIQUE INDEX agent_customer_answer_rule_scope ON stockchief_runtime.agent_customer_answer_rules(workspace_id,coalesce(customer_id,''));
CREATE INDEX agent_customer_answer_rule_customer ON stockchief_runtime.agent_customer_answer_rules(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX agent_customer_answer_rule_author ON stockchief_runtime.agent_customer_answer_rules(authorized_by);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_customer_questions'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_customer_answer_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN (VALUES
    ('stockchief_runtime.agent_customer_questions'::regclass),
    ('stockchief_runtime.agent_customer_answer_rules'::regclass)) r(relation);
