-- Jobs 73 and 74: quotes written from a customer's emailed request, and the
-- number of days after which open quotes are followed up.

-- The owner's quote settings: how many days a quote StockChief writes stays
-- valid (job 73), and how many days after a quote is emailed StockChief
-- follows it up (job 74). Either one counts as a rule while it is set.
CREATE TABLE stockchief_runtime.agent_quote_settings (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  valid_days integer CHECK (valid_days BETWEEN 1 AND 365),
  followup_days integer CHECK (followup_days BETWEEN 1 AND 365),
  enabled boolean GENERATED ALWAYS AS (valid_days IS NOT NULL OR followup_days IS NOT NULL) STORED,
  authorized_by text NOT NULL REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_quote_settings_author ON stockchief_runtime.agent_quote_settings(authorized_by);

-- Job 73: one row per customer email StockChief read as a quote request, with
-- what it did: wrote and emailed the quote, prepared it for approval, only
-- watched, or stopped for a person.
CREATE TABLE stockchief_runtime.agent_quote_requests (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES connection_email_messages(id) ON DELETE CASCADE,
  customer_id text REFERENCES customers(id) ON DELETE SET NULL,
  sender text NOT NULL,
  subject text,
  status text NOT NULL CHECK (status IN ('HELD','WATCHED','DRAFTED','QUOTED','EMAILED','DISMISSED')),
  reason text,
  proposal_id text,
  quote_id text REFERENCES sales_quotations(id) ON DELETE SET NULL,
  communication_id text REFERENCES customer_communications(id) ON DELETE SET NULL,
  automatic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,message_id),
  CHECK (status NOT IN ('QUOTED','EMAILED') OR quote_id IS NOT NULL),
  CHECK (status<>'EMAILED' OR communication_id IS NOT NULL),
  CHECK (status<>'DRAFTED' OR proposal_id IS NOT NULL)
);
CREATE INDEX agent_quote_request_message ON stockchief_runtime.agent_quote_requests(message_id);
CREATE INDEX agent_quote_request_customer ON stockchief_runtime.agent_quote_requests(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX agent_quote_request_quote ON stockchief_runtime.agent_quote_requests(quote_id) WHERE quote_id IS NOT NULL;
CREATE INDEX agent_quote_request_communication ON stockchief_runtime.agent_quote_requests(communication_id) WHERE communication_id IS NOT NULL;
CREATE INDEX agent_quote_request_waiting ON stockchief_runtime.agent_quote_requests(workspace_id,updated_at) WHERE status IN ('HELD','WATCHED','QUOTED');
CREATE INDEX agent_quote_request_recent ON stockchief_runtime.agent_quote_requests(workspace_id,updated_at DESC,message_id);

-- Job 74: a follow-up the owner stopped for one quote is never scheduled again
-- by the default delay.
ALTER TABLE stockchief_runtime.agent_quote_followups ADD COLUMN default_off boolean NOT NULL DEFAULT false;
CREATE INDEX agent_quote_followup_defaults ON stockchief_runtime.agent_quote_followups(workspace_id,presented_on,quote_id)
  WHERE schedule_enabled=0 AND presentation_basis='mailbox_accepted' AND NOT default_off;
UPDATE commercial_storage_usage u SET baseline_complete=false
  WHERE u.relation='stockchief_runtime.agent_quote_followups'::regclass
  AND EXISTS(SELECT 1 FROM stockchief_runtime.agent_quote_followups r WHERE r.workspace_id=u.workspace_id);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_quote_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_quote_requests'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN (VALUES
    ('stockchief_runtime.agent_quote_settings'::regclass),
    ('stockchief_runtime.agent_quote_requests'::regclass)) r(relation);
