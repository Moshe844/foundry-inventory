CREATE TABLE stockchief_runtime.agent_return_email_sources (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 message_id text NOT NULL REFERENCES connection_email_messages(id),
 customer_return_id text UNIQUE REFERENCES customer_returns(id),
 customer_id text REFERENCES customers(id),
 request_reference text,
 source_snapshot jsonb,
 source_fingerprint text,
 input_hash text,
 automatic boolean NOT NULL DEFAULT false,
 processed_by text REFERENCES users(id),
 problem text,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,message_id),
 CHECK(customer_return_id IS NULL OR (customer_id IS NOT NULL AND source_snapshot IS NOT NULL AND source_fingerprint IS NOT NULL AND input_hash IS NOT NULL AND processed_by IS NOT NULL))
);
CREATE INDEX agent_return_email_source_message ON stockchief_runtime.agent_return_email_sources(message_id);
CREATE INDEX agent_return_email_source_customer ON stockchief_runtime.agent_return_email_sources(customer_id);
CREATE UNIQUE INDEX agent_return_email_customer_reference ON stockchief_runtime.agent_return_email_sources(workspace_id,customer_id,lower(request_reference)) WHERE customer_return_id IS NOT NULL AND request_reference IS NOT NULL;
CREATE INDEX agent_return_email_source_owner ON stockchief_runtime.agent_return_email_sources(processed_by);
CREATE TABLE stockchief_runtime.agent_return_email_settings (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 quarantine_location_id text NOT NULL REFERENCES locations(id),
 maximum_units integer NOT NULL CHECK(maximum_units BETWEEN 1 AND 100000),
 authorized_by text NOT NULL REFERENCES users(id),
 enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE INDEX agent_return_email_setting_location ON stockchief_runtime.agent_return_email_settings(quarantine_location_id);
CREATE INDEX agent_return_email_setting_owner ON stockchief_runtime.agent_return_email_settings(authorized_by);
CREATE TABLE stockchief_runtime.agent_return_email_rules (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 scope_hash text NOT NULL,
 scope jsonb NOT NULL,
 maximum_units integer NOT NULL CHECK(maximum_units BETWEEN 1 AND 100000),
 authorized_by text NOT NULL REFERENCES users(id),
 example_message_id text NOT NULL REFERENCES connection_email_messages(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 PRIMARY KEY(workspace_id,scope_hash)
);
CREATE INDEX agent_return_email_rule_owner ON stockchief_runtime.agent_return_email_rules(authorized_by);
CREATE INDEX agent_return_email_rule_customer ON stockchief_runtime.agent_return_email_rules(workspace_id,(scope->>'customerId'));
CREATE INDEX agent_return_email_rule_example ON stockchief_runtime.agent_return_email_rules(example_message_id);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_return_email_sources'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_return_email_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_return_email_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_return_email_sources'::regclass,'stockchief_runtime.agent_return_email_settings'::regclass,'stockchief_runtime.agent_return_email_rules'::regclass]) r;
ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email'));
