CREATE TABLE stockchief_runtime.agent_blanket_contracts (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id),
 destination_id text NOT NULL REFERENCES locations(id),
 reference text NOT NULL,
 currency text NOT NULL,
 first_release text NOT NULL,
 last_release text NOT NULL,
 interval_days integer NOT NULL CHECK(interval_days BETWEEN 1 AND 365),
 lead_days integer NOT NULL CHECK(lead_days BETWEEN 0 AND 365),
 line_terms jsonb NOT NULL,
 goods_value_minor bigint NOT NULL CHECK(goods_value_minor>=0),
 source_snapshot jsonb NOT NULL,
 source_hash text NOT NULL,
 authorized_by text NOT NULL REFERENCES users(id),
 enabled boolean NOT NULL DEFAULT false,
 trained_release_id text,
 training_signature text,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 next_check_at timestamptz,
 last_issue text,
 stopped boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,supplier_id,reference)
);
CREATE UNIQUE INDEX agent_blanket_contract_reference ON stockchief_runtime.agent_blanket_contracts(workspace_id,supplier_id,lower(reference));
CREATE INDEX agent_blanket_contract_supplier ON stockchief_runtime.agent_blanket_contracts(supplier_id);
CREATE INDEX agent_blanket_contract_destination ON stockchief_runtime.agent_blanket_contracts(destination_id);
CREATE INDEX agent_blanket_contract_owner ON stockchief_runtime.agent_blanket_contracts(authorized_by);
CREATE INDEX agent_blanket_contract_due ON stockchief_runtime.agent_blanket_contracts(workspace_id,next_check_at,id) WHERE enabled;
CREATE TABLE stockchief_runtime.agent_blanket_releases (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 contract_id text NOT NULL REFERENCES stockchief_runtime.agent_blanket_contracts(id) ON DELETE CASCADE,
 release_date text NOT NULL,
 expected_date text NOT NULL,
 lines jsonb NOT NULL,
 goods_value_minor bigint NOT NULL CHECK(goods_value_minor>=0),
 status text NOT NULL DEFAULT 'PLANNED' CHECK(status IN ('PLANNED','DRAFTED','SKIPPED')),
 purchase_order_id text REFERENCES purchase_orders(id),
 automatic boolean NOT NULL DEFAULT false,
 prepared_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,contract_id,release_date)
);
CREATE INDEX agent_blanket_release_parent ON stockchief_runtime.agent_blanket_releases(contract_id);
CREATE INDEX agent_blanket_release_order ON stockchief_runtime.agent_blanket_releases(purchase_order_id);
CREATE INDEX agent_blanket_release_schedule ON stockchief_runtime.agent_blanket_releases(workspace_id,contract_id,status,release_date,id);
ALTER TABLE stockchief_runtime.agent_blanket_contracts ADD FOREIGN KEY(trained_release_id) REFERENCES stockchief_runtime.agent_blanket_releases(id) ON DELETE SET NULL;
CREATE INDEX agent_blanket_contract_example ON stockchief_runtime.agent_blanket_contracts(trained_release_id);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_blanket_contracts'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_blanket_releases'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables r
 WHERE r.relation IN ('stockchief_runtime.agent_blanket_contracts'::regclass,'stockchief_runtime.agent_blanket_releases'::regclass);

ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK(activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details','po-delivery-date','container-plan','team-procedure','product-retirement','shutdown-purchase','promotion-purchase','delivery-qc','supplier-rfq','supplier-claim','customer-reservation','customer-priority','channel-buffer','annual-stocktake','partial-shipment','return-label','export-papers','return-disposition','customer-page-order','channel-copy','blanket-release'));
