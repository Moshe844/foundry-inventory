CREATE TABLE stockchief_runtime.agent_supplier_term_sources (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 message_id text NOT NULL REFERENCES connection_email_messages(id),
 supplier_id text REFERENCES suppliers(id),
 source_snapshot jsonb,
 instruction_hash text,
 changed_count integer NOT NULL DEFAULT 0 CHECK(changed_count>=0),
 automatic boolean NOT NULL DEFAULT false,
 processed_by text REFERENCES users(id),
 processed_at timestamptz,
 problem text,
 PRIMARY KEY(workspace_id,message_id),
 CHECK(processed_at IS NULL OR (supplier_id IS NOT NULL AND source_snapshot IS NOT NULL AND instruction_hash IS NOT NULL AND processed_by IS NOT NULL))
);
CREATE INDEX agent_supplier_term_source_message ON stockchief_runtime.agent_supplier_term_sources(message_id);
CREATE INDEX agent_supplier_term_source_supplier ON stockchief_runtime.agent_supplier_term_sources(supplier_id);
CREATE INDEX agent_supplier_term_source_owner ON stockchief_runtime.agent_supplier_term_sources(processed_by);
CREATE INDEX agent_supplier_term_source_completed ON stockchief_runtime.agent_supplier_term_sources(workspace_id,processed_at) WHERE processed_at IS NOT NULL AND changed_count>0;
CREATE TABLE stockchief_runtime.agent_supplier_term_settings (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id),
 scope jsonb NOT NULL,
 scope_hash text NOT NULL,
 limits jsonb NOT NULL,
 authorized_by text NOT NULL REFERENCES users(id),
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 PRIMARY KEY(workspace_id,supplier_id)
);
CREATE INDEX agent_supplier_term_setting_supplier ON stockchief_runtime.agent_supplier_term_settings(supplier_id);
CREATE INDEX agent_supplier_term_setting_owner ON stockchief_runtime.agent_supplier_term_settings(authorized_by);
CREATE TABLE stockchief_runtime.agent_supplier_term_rules (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 scope_hash text NOT NULL,
 scope jsonb NOT NULL,
 limits jsonb NOT NULL,
 authorized_by text NOT NULL REFERENCES users(id),
 example_message_id text NOT NULL REFERENCES connection_email_messages(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 PRIMARY KEY(workspace_id,scope_hash)
);
CREATE INDEX agent_supplier_term_rule_owner ON stockchief_runtime.agent_supplier_term_rules(authorized_by);
CREATE INDEX agent_supplier_term_rule_example ON stockchief_runtime.agent_supplier_term_rules(example_message_id);
CREATE INDEX agent_supplier_term_rule_supplier ON stockchief_runtime.agent_supplier_term_rules(workspace_id,(scope->>'supplierId'));
CREATE TABLE stockchief_runtime.agent_supplier_term_heads (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id),
 target_id text NOT NULL,
 field text NOT NULL CHECK(field IN ('lead_time_days','minimum_order_quantity','contact_name','phone')),
 message_id text NOT NULL REFERENCES connection_email_messages(id),
 received_at timestamptz NOT NULL,
 effective_date date NOT NULL,
 authority_at timestamptz NOT NULL,
 record_updated_at text NOT NULL,
 applied_value jsonb NOT NULL,
 automatic boolean NOT NULL,
 PRIMARY KEY(workspace_id,supplier_id,target_id,field)
);
CREATE INDEX agent_supplier_term_head_supplier ON stockchief_runtime.agent_supplier_term_heads(supplier_id);
CREATE INDEX agent_supplier_term_head_message ON stockchief_runtime.agent_supplier_term_heads(message_id);
CREATE INDEX agent_supplier_term_mail_review ON connection_email_messages(workspace_id,received_at,id)
 WHERE classification='supplier' AND lower(coalesce(subject,'')) ~ '^(supplier (terms|details) update|lead time and minimum order update)([[:space:]]*[:#-][[:space:]]*[a-z0-9_.-]+)?[.!]?$';
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_supplier_term_sources'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_term_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_term_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_term_heads'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_supplier_term_sources'::regclass,'stockchief_runtime.agent_supplier_term_settings'::regclass,'stockchief_runtime.agent_supplier_term_rules'::regclass,'stockchief_runtime.agent_supplier_term_heads'::regclass]) r;
ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details'));
