CREATE TABLE stockchief_runtime.agent_po_date_settings (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id),
 scope jsonb NOT NULL,
 scope_hash text NOT NULL,
 limits jsonb NOT NULL,
 authorized_by text NOT NULL REFERENCES users(id),
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 UNIQUE(workspace_id,scope_hash)
);
CREATE INDEX agent_po_date_setting_supplier ON stockchief_runtime.agent_po_date_settings(supplier_id);
CREATE INDEX agent_po_date_setting_owner ON stockchief_runtime.agent_po_date_settings(authorized_by);
CREATE INDEX agent_po_date_setting_scope ON stockchief_runtime.agent_po_date_settings(workspace_id,supplier_id) WHERE enabled;
CREATE TABLE stockchief_runtime.agent_po_date_rules (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id),
 scope_hash text NOT NULL,
 scope jsonb NOT NULL,
 limits jsonb NOT NULL,
 authorized_by text NOT NULL REFERENCES users(id),
 example_source_id text NOT NULL REFERENCES stockchief_runtime.supplier_link_submissions(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 PRIMARY KEY(workspace_id,scope_hash)
);
CREATE INDEX agent_po_date_rule_supplier ON stockchief_runtime.agent_po_date_rules(supplier_id);
CREATE INDEX agent_po_date_rule_owner ON stockchief_runtime.agent_po_date_rules(authorized_by);
CREATE INDEX agent_po_date_rule_example ON stockchief_runtime.agent_po_date_rules(example_source_id);
CREATE TABLE stockchief_runtime.agent_po_date_sources (
 source_id text PRIMARY KEY REFERENCES stockchief_runtime.supplier_link_submissions(id) ON DELETE CASCADE,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 purchase_order_id text REFERENCES purchase_orders(id),
 captured_expected_date text,
 captured_order_profile_hash text,
 source_snapshot jsonb,
 instruction_hash text,
 changed boolean NOT NULL DEFAULT false,
 automatic boolean NOT NULL DEFAULT false,
 processed_by text REFERENCES users(id),
 processed_at timestamptz,
 archived_at timestamptz,
 problem text,
 retry_after timestamptz,
 CHECK(processed_at IS NULL OR (source_snapshot IS NOT NULL AND instruction_hash IS NOT NULL AND processed_by IS NOT NULL))
);
CREATE INDEX agent_po_date_source_workspace ON stockchief_runtime.agent_po_date_sources(workspace_id,retry_after,source_id) WHERE processed_at IS NULL AND archived_at IS NULL;
CREATE INDEX agent_po_date_source_order ON stockchief_runtime.agent_po_date_sources(purchase_order_id);
CREATE INDEX agent_po_date_source_owner ON stockchief_runtime.agent_po_date_sources(processed_by);
CREATE INDEX agent_po_date_source_completed ON stockchief_runtime.agent_po_date_sources(workspace_id,processed_at) WHERE processed_at IS NOT NULL AND changed;
CREATE TABLE stockchief_runtime.agent_po_date_heads (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 purchase_order_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
 source_id text NOT NULL REFERENCES stockchief_runtime.supplier_link_submissions(id),
 received_at timestamptz NOT NULL,
 record_updated_at text NOT NULL,
 expected_date date NOT NULL,
 original_expected_date date NOT NULL,
 order_profile_hash text NOT NULL,
 automatic boolean NOT NULL,
 PRIMARY KEY(workspace_id,purchase_order_id)
);
CREATE INDEX agent_po_date_head_order ON stockchief_runtime.agent_po_date_heads(purchase_order_id);
CREATE INDEX agent_po_date_head_source ON stockchief_runtime.agent_po_date_heads(source_id);
CREATE INDEX agent_po_date_link_review ON stockchief_runtime.supplier_link_submissions(workspace_id,created_at,id) WHERE kind IN ('date','confirm') AND expected_date IS NOT NULL;
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_po_date_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_po_date_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_po_date_sources'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_po_date_heads'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_po_date_settings'::regclass,'stockchief_runtime.agent_po_date_rules'::regclass,'stockchief_runtime.agent_po_date_sources'::regclass,'stockchief_runtime.agent_po_date_heads'::regclass])r;
ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details','po-delivery-date'));
