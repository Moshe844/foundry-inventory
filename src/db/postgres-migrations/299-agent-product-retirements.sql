CREATE TABLE stockchief_runtime.agent_product_retirement_notices (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id), reference text NOT NULL,
 products text NOT NULL, source_fingerprint text NOT NULL, source_snapshot jsonb NOT NULL,
 recorded_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 applied_at timestamptz, applied_by text REFERENCES users(id), automatic boolean, result jsonb,last_issue text,
 UNIQUE(workspace_id,supplier_id,reference)
);
CREATE INDEX agent_product_retirement_supplier ON stockchief_runtime.agent_product_retirement_notices(supplier_id);
CREATE INDEX agent_product_retirement_recorder ON stockchief_runtime.agent_product_retirement_notices(recorded_by);
CREATE INDEX agent_product_retirement_applier ON stockchief_runtime.agent_product_retirement_notices(applied_by);
CREATE INDEX agent_product_retirement_history ON stockchief_runtime.agent_product_retirement_notices(workspace_id,created_at DESC,id DESC);
CREATE INDEX agent_product_retirement_work ON stockchief_runtime.agent_product_retirement_notices(workspace_id,applied_at,id) WHERE applied_at IS NOT NULL;
CREATE INDEX agent_product_retirement_issues ON stockchief_runtime.agent_product_retirement_notices(workspace_id,created_at,id) WHERE applied_at IS NULL AND last_issue IS NOT NULL;
CREATE TABLE stockchief_runtime.agent_product_replacements (
 old_sku_id text PRIMARY KEY REFERENCES skus(id) ON DELETE CASCADE,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 replacement_sku_id text NOT NULL REFERENCES skus(id),
 notice_id text NOT NULL REFERENCES stockchief_runtime.agent_product_retirement_notices(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(old_sku_id<>replacement_sku_id)
);
CREATE INDEX agent_product_replacement_target ON stockchief_runtime.agent_product_replacements(replacement_sku_id);
CREATE INDEX agent_product_replacement_notice ON stockchief_runtime.agent_product_replacements(notice_id);
CREATE INDEX agent_product_replacement_workspace ON stockchief_runtime.agent_product_replacements(workspace_id,old_sku_id);
CREATE TABLE stockchief_runtime.agent_product_retirement_settings (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id),
 enabled boolean NOT NULL DEFAULT false, maximum_products integer NOT NULL CHECK(maximum_products BETWEEN 1 AND 100),
 supplier_snapshot jsonb NOT NULL, authorized_by text NOT NULL REFERENCES users(id),
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(), revision integer NOT NULL DEFAULT 1,
 taught_notice_id text REFERENCES stockchief_runtime.agent_product_retirement_notices(id),
 taught_maximum integer CHECK(taught_maximum BETWEEN 1 AND 100),
 PRIMARY KEY(workspace_id,supplier_id)
);
CREATE INDEX agent_product_retirement_settings_supplier ON stockchief_runtime.agent_product_retirement_settings(supplier_id);
CREATE INDEX agent_product_retirement_settings_owner ON stockchief_runtime.agent_product_retirement_settings(authorized_by);
CREATE INDEX agent_product_retirement_settings_example ON stockchief_runtime.agent_product_retirement_settings(taught_notice_id);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_product_retirement_notices'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_product_replacements'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_product_retirement_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_product_retirement_notices'::regclass,'stockchief_runtime.agent_product_replacements'::regclass,'stockchief_runtime.agent_product_retirement_settings'::regclass])r;
ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details','po-delivery-date','container-plan','team-procedure','product-retirement'));
