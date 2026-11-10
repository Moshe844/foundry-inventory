CREATE TABLE stockchief_runtime.agent_channel_copy_sets (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 label text NOT NULL,
 sku_ids jsonb NOT NULL,
 channel_name text NOT NULL,
 title_limit integer NOT NULL CHECK(title_limit BETWEEN 40 AND 240),
 description_style text NOT NULL CHECK(description_style IN ('paragraph','bullets')),
 include_description boolean NOT NULL DEFAULT false,
 authorized_by text NOT NULL REFERENCES users(id),
 enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 next_check_at timestamptz,
 last_issue text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,label)
);
CREATE INDEX agent_channel_copy_author ON stockchief_runtime.agent_channel_copy_sets(authorized_by);
CREATE INDEX agent_channel_copy_due ON stockchief_runtime.agent_channel_copy_sets(workspace_id,next_check_at,id) WHERE enabled;
CREATE TABLE stockchief_runtime.agent_channel_copy_versions (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 copy_id text NOT NULL REFERENCES stockchief_runtime.agent_channel_copy_sets(id) ON DELETE CASCADE,
 source_hash text NOT NULL,
 source_snapshot jsonb NOT NULL,
 document_hash text NOT NULL,
 document jsonb NOT NULL,
 generated_by text NOT NULL REFERENCES users(id),
 automatic boolean NOT NULL,
 exported_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,copy_id,source_hash)
);
CREATE INDEX agent_channel_copy_version_owner ON stockchief_runtime.agent_channel_copy_versions(generated_by);
CREATE INDEX agent_channel_copy_version_parent ON stockchief_runtime.agent_channel_copy_versions(copy_id);
CREATE INDEX agent_channel_copy_version_history ON stockchief_runtime.agent_channel_copy_versions(workspace_id,copy_id,created_at DESC,id DESC);
CREATE INDEX agent_channel_copy_export_history ON stockchief_runtime.agent_channel_copy_versions(workspace_id,document_hash,exported_at,id) WHERE exported_at IS NOT NULL;
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_channel_copy_sets'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_channel_copy_versions'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables r
 WHERE r.relation IN ('stockchief_runtime.agent_channel_copy_sets'::regclass,'stockchief_runtime.agent_channel_copy_versions'::regclass);

ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK(activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details','po-delivery-date','container-plan','team-procedure','product-retirement','shutdown-purchase','promotion-purchase','delivery-qc','supplier-rfq','supplier-claim','customer-reservation','customer-priority','channel-buffer','annual-stocktake','partial-shipment','return-label','export-papers','return-disposition','customer-page-order','channel-copy'));
