CREATE TABLE stockchief_runtime.agent_quote_followups (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 quote_id text NOT NULL REFERENCES sales_quotations(id),
 quote_hash text NOT NULL,
 customer_id text NOT NULL REFERENCES customers(id),
 recipient text NOT NULL,
 presented_on date NOT NULL,
 presentation_channel text NOT NULL CHECK(presentation_channel IN ('email','in_person','phone','customer_portal','post')),
 presentation_evidence text NOT NULL CHECK(length(presentation_evidence) BETWEEN 1 AND 1000),
 confirmed_by text NOT NULL REFERENCES users(id),
 request_key text NOT NULL,
 input_hash text NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 schedule_enabled smallint NOT NULL DEFAULT 0 CHECK(schedule_enabled IN(0,1)),
 connector_id text REFERENCES workspace_connectors(id),
 mailbox_account text,
 provider_type text CHECK(provider_type IN('gmail','microsoft365')),
 followup_days integer CHECK(followup_days BETWEEN 1 AND 365),
 due_on date,
 scheduled_by text REFERENCES users(id),
 problem text,
 retry_after timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,quote_id),
 UNIQUE(workspace_id,request_key),
 CHECK(schedule_enabled=0 OR (connector_id IS NOT NULL AND mailbox_account IS NOT NULL AND provider_type IS NOT NULL AND followup_days IS NOT NULL AND due_on IS NOT NULL AND scheduled_by IS NOT NULL))
);
CREATE INDEX agent_quote_followup_quote ON stockchief_runtime.agent_quote_followups(quote_id);
CREATE INDEX agent_quote_followup_customer ON stockchief_runtime.agent_quote_followups(customer_id);
CREATE INDEX agent_quote_followup_confirmation_author ON stockchief_runtime.agent_quote_followups(confirmed_by);
CREATE INDEX agent_quote_followup_schedule_author ON stockchief_runtime.agent_quote_followups(scheduled_by);
CREATE INDEX agent_quote_followup_mailbox ON stockchief_runtime.agent_quote_followups(connector_id);
CREATE INDEX agent_quote_followup_due ON stockchief_runtime.agent_quote_followups(workspace_id,due_on,quote_id) WHERE schedule_enabled=1;
INSERT INTO commercial_storage_tables(relation,bytes_expression)
 VALUES('stockchief_runtime.agent_quote_followups'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_quote_followups'::regclass,true FROM workspaces;
