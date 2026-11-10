CREATE TABLE stockchief_runtime.agent_promotion_stock (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id),location_id text NOT NULL REFERENCES locations(id),
 reference text NOT NULL,scope jsonb NOT NULL,enabled boolean NOT NULL DEFAULT false,
 authorized_by text NOT NULL REFERENCES users(id),authorized_profile_hash text,
 maximum_minor bigint CHECK(maximum_minor>=0),
 refresh_days integer CHECK(refresh_days BETWEEN 1 AND 30),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 last_checked_at timestamptz,next_check_at timestamptz,last_issue text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,supplier_id,location_id,reference)
);
CREATE INDEX agent_promotion_stock_supplier ON stockchief_runtime.agent_promotion_stock(supplier_id);
CREATE INDEX agent_promotion_stock_location ON stockchief_runtime.agent_promotion_stock(location_id);
CREATE INDEX agent_promotion_stock_owner ON stockchief_runtime.agent_promotion_stock(authorized_by);
CREATE INDEX agent_promotion_stock_list ON stockchief_runtime.agent_promotion_stock(workspace_id,created_at DESC,id DESC);
CREATE INDEX agent_promotion_stock_due ON stockchief_runtime.agent_promotion_stock(workspace_id,next_check_at,id) WHERE enabled;
CREATE INDEX agent_promotion_stock_issue ON stockchief_runtime.agent_promotion_stock(workspace_id,last_checked_at,id) WHERE enabled AND last_issue IS NOT NULL;
CREATE TABLE stockchief_runtime.agent_promotion_stock_plans (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 promotion_id text NOT NULL REFERENCES stockchief_runtime.agent_promotion_stock(id) ON DELETE CASCADE,
 source_fingerprint text NOT NULL,source_snapshot jsonb NOT NULL,automatic boolean NOT NULL,
 created_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 purchase_order_id text REFERENCES purchase_orders(id),purchase_created_at timestamptz,
 UNIQUE(promotion_id,source_fingerprint)
);
CREATE UNIQUE INDEX agent_promotion_stock_one_purchase ON stockchief_runtime.agent_promotion_stock_plans(promotion_id) WHERE purchase_order_id IS NOT NULL;
CREATE INDEX agent_promotion_stock_plan_owner ON stockchief_runtime.agent_promotion_stock_plans(created_by);
CREATE INDEX agent_promotion_stock_plan_purchase ON stockchief_runtime.agent_promotion_stock_plans(purchase_order_id);
CREATE INDEX agent_promotion_stock_plan_list ON stockchief_runtime.agent_promotion_stock_plans(workspace_id,promotion_id,created_at DESC,id DESC);
CREATE INDEX agent_promotion_stock_purchase_work ON stockchief_runtime.agent_promotion_stock_plans(workspace_id,purchase_created_at,id) WHERE purchase_order_id IS NOT NULL;
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_promotion_stock'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_promotion_stock_plans'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_promotion_stock'::regclass,'stockchief_runtime.agent_promotion_stock_plans'::regclass])r;
ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details','po-delivery-date','container-plan','team-procedure','product-retirement','shutdown-purchase','promotion-purchase'));
