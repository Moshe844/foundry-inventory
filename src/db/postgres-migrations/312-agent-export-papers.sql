ALTER TABLE sales_shipments ADD COLUMN ship_to_address_fields jsonb;

CREATE TABLE stockchief_runtime.agent_export_profiles (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 country_code text NOT NULL,delivery_terms text NOT NULL,approved_by text NOT NULL REFERENCES users(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE stockchief_runtime.agent_export_product_facts (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,sku_id text NOT NULL REFERENCES skus(id),
 description text NOT NULL,hs_code text NOT NULL,origin_country text NOT NULL,net_weight_grams integer NOT NULL CHECK(net_weight_grams>0),
 approved_by text NOT NULL REFERENCES users(id),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,sku_id)
);
CREATE INDEX agent_export_fact_owner ON stockchief_runtime.agent_export_product_facts(approved_by);
CREATE INDEX agent_export_profile_owner ON stockchief_runtime.agent_export_profiles(approved_by);
CREATE TABLE stockchief_runtime.agent_export_origin_facts (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,location_id text NOT NULL REFERENCES locations(id),
 address_fields jsonb NOT NULL,approved_by text NOT NULL REFERENCES users(id),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(workspace_id,location_id)
);
CREATE INDEX agent_export_origin_owner ON stockchief_runtime.agent_export_origin_facts(approved_by);
CREATE TABLE stockchief_runtime.agent_export_paper_packets (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,shipment_id text NOT NULL REFERENCES sales_shipments(id),
 owner_id text NOT NULL REFERENCES users(id),source_snapshot jsonb NOT NULL,source_hash text NOT NULL,status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','REVIEWED','STOPPED')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),draft_pdf bytea NOT NULL,reviewed_pdf bytea,reviewed_by text REFERENCES users(id),
 reviewed_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(workspace_id,shipment_id,source_hash),
 CHECK(status<>'REVIEWED' OR reviewed_pdf IS NOT NULL)
);
CREATE INDEX agent_export_packet_workspace ON stockchief_runtime.agent_export_paper_packets(workspace_id,created_at DESC,id);
CREATE INDEX agent_export_packet_shipment ON stockchief_runtime.agent_export_paper_packets(shipment_id);
CREATE INDEX agent_export_packet_owner ON stockchief_runtime.agent_export_paper_packets(owner_id);
CREATE INDEX agent_export_packet_reviewer ON stockchief_runtime.agent_export_paper_packets(reviewed_by);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_export_profiles'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_export_product_facts'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_export_origin_facts'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_export_paper_packets'::regclass,'octet_length(t.draft_pdf)+coalesce(octet_length(t.reviewed_pdf),0)+octet_length(convert_to((to_jsonb(t)-''draft_pdf''-''reviewed_pdf'')::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_export_profiles'::regclass,'stockchief_runtime.agent_export_product_facts'::regclass,'stockchief_runtime.agent_export_origin_facts'::regclass,'stockchief_runtime.agent_export_paper_packets'::regclass])r;

CREATE INDEX agent_export_packet_pending ON stockchief_runtime.agent_export_paper_packets(workspace_id,created_at) WHERE status='DRAFT';

ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details','po-delivery-date','container-plan','team-procedure','product-retirement','shutdown-purchase','promotion-purchase','delivery-qc','supplier-rfq','supplier-claim','customer-reservation','customer-priority','channel-buffer','annual-stocktake','partial-shipment','return-label','export-papers'));
