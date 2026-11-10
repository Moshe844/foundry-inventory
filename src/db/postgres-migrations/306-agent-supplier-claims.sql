CREATE TABLE stockchief_runtime.agent_quality_photos (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 hold_id text NOT NULL REFERENCES stockchief_runtime.agent_quality_holds(id),
 filename text NOT NULL,mime_type text NOT NULL,content_hash text NOT NULL,content bytea NOT NULL,
 email_hash text NOT NULL,email_content bytea NOT NULL,email_width integer NOT NULL,email_height integer NOT NULL,
 caption text NOT NULL DEFAULT '',created_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(hold_id,content_hash),CHECK(octet_length(content) BETWEEN 1 AND 10485760),
 CHECK(octet_length(email_content) BETWEEN 1 AND 614400),CHECK(email_width>0 AND email_height>0)
);
CREATE INDEX agent_quality_photo_workspace ON stockchief_runtime.agent_quality_photos(workspace_id,created_at,id);
CREATE INDEX agent_quality_photo_creator ON stockchief_runtime.agent_quality_photos(created_by);
CREATE TABLE stockchief_runtime.agent_supplier_claim_rules (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id),sku_id text NOT NULL REFERENCES skus(id),location_id text NOT NULL REFERENCES locations(id),
 connector_id text NOT NULL REFERENCES workspace_connectors(id),authorized_by text NOT NULL REFERENCES users(id),
 scope jsonb NOT NULL,profile_hash text NOT NULL,currency text NOT NULL,
 max_units integer NOT NULL CHECK(max_units BETWEEN 1 AND 100000),
 max_value_minor bigint NOT NULL CHECK(max_value_minor>0),max_weekly_minor bigint NOT NULL CHECK(max_weekly_minor>=max_value_minor),
 max_age_days integer NOT NULL CHECK(max_age_days BETWEEN 1 AND 365),include_photos boolean NOT NULL DEFAULT false,example_id text,enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_supplier_claim_rule_supplier ON stockchief_runtime.agent_supplier_claim_rules(supplier_id);
CREATE INDEX agent_supplier_claim_rule_sku ON stockchief_runtime.agent_supplier_claim_rules(sku_id);
CREATE INDEX agent_supplier_claim_rule_location ON stockchief_runtime.agent_supplier_claim_rules(location_id);
CREATE INDEX agent_supplier_claim_rule_connector ON stockchief_runtime.agent_supplier_claim_rules(connector_id);
CREATE INDEX agent_supplier_claim_rule_owner ON stockchief_runtime.agent_supplier_claim_rules(authorized_by);
CREATE UNIQUE INDEX agent_supplier_claim_rule_scope ON stockchief_runtime.agent_supplier_claim_rules(workspace_id,supplier_id,sku_id,location_id) WHERE enabled;
CREATE TABLE stockchief_runtime.agent_supplier_claims (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 hold_id text NOT NULL UNIQUE REFERENCES stockchief_runtime.agent_quality_holds(id),
 reference text NOT NULL,prepared_by text NOT NULL REFERENCES users(id),snapshot jsonb NOT NULL,source_fingerprint text NOT NULL,
 communication_id text REFERENCES supplier_communications(id),automatic boolean NOT NULL DEFAULT false,
 rule_id text REFERENCES stockchief_runtime.agent_supplier_claim_rules(id),rule_revision integer,automatic_reserved_at timestamptz,
 reviewed_by text REFERENCES users(id),reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(NOT automatic OR rule_id IS NOT NULL),UNIQUE(workspace_id,reference)
);
CREATE INDEX agent_supplier_claim_workspace ON stockchief_runtime.agent_supplier_claims(workspace_id,created_at DESC,id DESC);
CREATE INDEX agent_supplier_claim_preparer ON stockchief_runtime.agent_supplier_claims(prepared_by);
CREATE INDEX agent_supplier_claim_communication ON stockchief_runtime.agent_supplier_claims(communication_id);
CREATE INDEX agent_supplier_claim_rule_usage ON stockchief_runtime.agent_supplier_claims(rule_id,automatic_reserved_at);
CREATE INDEX agent_supplier_claim_reviewer ON stockchief_runtime.agent_supplier_claims(reviewed_by);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_quality_photos'::regclass,'octet_length(t.content)+octet_length(t.email_content)+octet_length(convert_to((to_jsonb(t)-''content''-''email_content'')::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_claim_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_claims'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_quality_photos'::regclass,'stockchief_runtime.agent_supplier_claim_rules'::regclass,'stockchief_runtime.agent_supplier_claims'::regclass])r;

ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details','po-delivery-date','container-plan','team-procedure','product-retirement','shutdown-purchase','promotion-purchase','delivery-qc','supplier-rfq','supplier-claim'));
