CREATE TABLE stockchief_runtime.agent_customer_order_pages (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 customer_id text NOT NULL REFERENCES customers(id),location_id text NOT NULL REFERENCES locations(id),
 label text NOT NULL,delivery_method text NOT NULL CHECK(delivery_method IN('SHIP','PICKUP')),
 currency text NOT NULL,tax_rate_id text REFERENCES accounting_tax_rates(id),tax_treatment text NOT NULL,
 sku_ids jsonb NOT NULL,source_snapshot jsonb NOT NULL,source_hash text NOT NULL,
 maximum_units integer NOT NULL CHECK(maximum_units BETWEEN 1 AND 100000),maximum_minor bigint NOT NULL CHECK(maximum_minor>0),
 token_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,enabled boolean NOT NULL DEFAULT true,
 routine_enabled boolean NOT NULL DEFAULT false,authorized_by text NOT NULL REFERENCES users(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_customer_page_customer ON stockchief_runtime.agent_customer_order_pages(customer_id);
CREATE INDEX agent_customer_page_location ON stockchief_runtime.agent_customer_order_pages(location_id);
CREATE INDEX agent_customer_page_tax ON stockchief_runtime.agent_customer_order_pages(tax_rate_id);
CREATE INDEX agent_customer_page_owner ON stockchief_runtime.agent_customer_order_pages(authorized_by);
CREATE UNIQUE INDEX agent_customer_page_label ON stockchief_runtime.agent_customer_order_pages(workspace_id,lower(label));
CREATE TABLE stockchief_runtime.agent_customer_page_requests (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 page_id text NOT NULL REFERENCES stockchief_runtime.agent_customer_order_pages(id),customer_id text NOT NULL REFERENCES customers(id),
 reference text NOT NULL,reference_key text NOT NULL,source_hash text NOT NULL,request_hash text NOT NULL,
 snapshot jsonb NOT NULL,status text NOT NULL DEFAULT 'RECEIVED' CHECK(status IN('RECEIVED','DRAFTED','STOPPED')),
 sales_order_id text REFERENCES sales_orders(id),automatic boolean NOT NULL DEFAULT false,processed_by text REFERENCES users(id),
 problem text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),processed_at timestamptz,
 UNIQUE(workspace_id,customer_id,reference_key)
);
CREATE INDEX agent_customer_request_page ON stockchief_runtime.agent_customer_page_requests(page_id);
CREATE INDEX agent_customer_request_customer ON stockchief_runtime.agent_customer_page_requests(customer_id);
CREATE INDEX agent_customer_request_order ON stockchief_runtime.agent_customer_page_requests(sales_order_id);
CREATE INDEX agent_customer_request_owner ON stockchief_runtime.agent_customer_page_requests(processed_by);
CREATE INDEX agent_customer_request_pending ON stockchief_runtime.agent_customer_page_requests(workspace_id,created_at) WHERE status='RECEIVED';
CREATE TABLE stockchief_runtime.agent_customer_page_rules (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 page_id text NOT NULL REFERENCES stockchief_runtime.agent_customer_order_pages(id),scope_hash text NOT NULL,scope jsonb NOT NULL,
 example_request_id text NOT NULL REFERENCES stockchief_runtime.agent_customer_page_requests(id),
 authorized_by text NOT NULL REFERENCES users(id),enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(workspace_id,page_id,scope_hash)
);
CREATE INDEX agent_customer_rule_page ON stockchief_runtime.agent_customer_page_rules(page_id);
CREATE INDEX agent_customer_rule_example ON stockchief_runtime.agent_customer_page_rules(example_request_id);
CREATE INDEX agent_customer_rule_owner ON stockchief_runtime.agent_customer_page_rules(authorized_by);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_customer_order_pages'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_customer_page_requests'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_customer_page_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_customer_order_pages'::regclass,'stockchief_runtime.agent_customer_page_requests'::regclass,'stockchief_runtime.agent_customer_page_rules'::regclass])r;

ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK(activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details','po-delivery-date','container-plan','team-procedure','product-retirement','shutdown-purchase','promotion-purchase','delivery-qc','supplier-rfq','supplier-claim','customer-reservation','customer-priority','channel-buffer','annual-stocktake','partial-shipment','return-label','export-papers','return-disposition','customer-page-order'));
