CREATE TABLE stockchief_runtime.agent_rfq_requests (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 request_key text NOT NULL,input_hash text NOT NULL,snapshot jsonb NOT NULL,source_fingerprint text NOT NULL,
 prepared_by text NOT NULL REFERENCES users(id),reviewed_by text REFERENCES users(id),reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,request_key)
);
CREATE INDEX agent_rfq_request_owner ON stockchief_runtime.agent_rfq_requests(prepared_by);
CREATE INDEX agent_rfq_request_reviewer ON stockchief_runtime.agent_rfq_requests(reviewed_by);
CREATE INDEX agent_rfq_request_list ON stockchief_runtime.agent_rfq_requests(workspace_id,created_at DESC,id DESC);
CREATE TABLE stockchief_runtime.agent_rfq_rules (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 scope jsonb NOT NULL,profile_hash text NOT NULL,enabled boolean NOT NULL DEFAULT true,
 max_requests_per_week integer NOT NULL CHECK(max_requests_per_week BETWEEN 1 AND 20),
 authorized_by text NOT NULL REFERENCES users(id),example_id text REFERENCES stockchief_runtime.agent_rfq_requests(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_rfq_rule_owner ON stockchief_runtime.agent_rfq_rules(authorized_by);
CREATE INDEX agent_rfq_rule_example ON stockchief_runtime.agent_rfq_rules(example_id);
CREATE INDEX agent_rfq_rule_list ON stockchief_runtime.agent_rfq_rules(workspace_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX agent_rfq_rule_active_profile ON stockchief_runtime.agent_rfq_rules(workspace_id,profile_hash) WHERE enabled;
CREATE TABLE stockchief_runtime.agent_rfq_deliveries (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 request_id text NOT NULL REFERENCES stockchief_runtime.agent_rfq_requests(id),
 supplier_id text NOT NULL REFERENCES suppliers(id),communication_id text NOT NULL REFERENCES supplier_communications(id),
 automatic boolean NOT NULL,rule_id text REFERENCES stockchief_runtime.agent_rfq_rules(id),rule_revision integer,
 approved_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(request_id,supplier_id),CHECK(automatic=(rule_id IS NOT NULL))
);
CREATE INDEX agent_rfq_delivery_workspace ON stockchief_runtime.agent_rfq_deliveries(workspace_id,created_at,id);
CREATE INDEX agent_rfq_delivery_supplier ON stockchief_runtime.agent_rfq_deliveries(supplier_id);
CREATE INDEX agent_rfq_delivery_communication ON stockchief_runtime.agent_rfq_deliveries(communication_id);
CREATE INDEX agent_rfq_delivery_rule ON stockchief_runtime.agent_rfq_deliveries(rule_id,created_at);
CREATE INDEX agent_rfq_delivery_owner ON stockchief_runtime.agent_rfq_deliveries(approved_by);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_rfq_requests'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_rfq_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_rfq_deliveries'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_rfq_requests'::regclass,'stockchief_runtime.agent_rfq_rules'::regclass,'stockchief_runtime.agent_rfq_deliveries'::regclass])r;

ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details','po-delivery-date','container-plan','team-procedure','product-retirement','shutdown-purchase','promotion-purchase','delivery-qc','supplier-rfq'));
