CREATE TABLE stockchief_runtime.agent_team_procedure_sets (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('receiving','dispatch','counting')),
 location_id text NOT NULL REFERENCES locations(id),
 lookback_days integer NOT NULL CHECK(lookback_days BETWEEN 1 AND 3650),
 authorized_by text NOT NULL REFERENCES users(id),
 enabled boolean NOT NULL DEFAULT false,
 pending_review boolean NOT NULL DEFAULT false,
 refresh_days integer CHECK(refresh_days BETWEEN 1 AND 90),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 last_checked_at timestamptz,next_check_at timestamptz,last_issue text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,kind,location_id)
);
CREATE INDEX agent_team_procedure_location ON stockchief_runtime.agent_team_procedure_sets(location_id);
CREATE INDEX agent_team_procedure_owner ON stockchief_runtime.agent_team_procedure_sets(authorized_by);
CREATE INDEX agent_team_procedure_workspace ON stockchief_runtime.agent_team_procedure_sets(workspace_id,created_at DESC,id);
CREATE INDEX agent_team_procedure_due ON stockchief_runtime.agent_team_procedure_sets(workspace_id,next_check_at,id) WHERE enabled;
CREATE INDEX agent_team_procedure_issues ON stockchief_runtime.agent_team_procedure_sets(workspace_id,last_checked_at,id) WHERE (enabled AND last_issue IS NOT NULL) OR pending_review;
CREATE TABLE stockchief_runtime.agent_team_procedure_versions (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 procedure_id text NOT NULL REFERENCES stockchief_runtime.agent_team_procedure_sets(id) ON DELETE CASCADE,
 source_fingerprint text NOT NULL, source_snapshot jsonb NOT NULL, document jsonb NOT NULL, document_hash text NOT NULL,
 generated_by text NOT NULL REFERENCES users(id), automatic boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(procedure_id,source_fingerprint),UNIQUE(workspace_id,procedure_id,id)
);
CREATE INDEX agent_team_procedure_version_owner ON stockchief_runtime.agent_team_procedure_versions(generated_by);
CREATE INDEX agent_team_procedure_versions_workspace ON stockchief_runtime.agent_team_procedure_versions(workspace_id,procedure_id,created_at DESC,id DESC);
CREATE INDEX agent_team_procedure_material_history ON stockchief_runtime.agent_team_procedure_versions(workspace_id,procedure_id,document_hash,created_at,id);
CREATE TABLE stockchief_runtime.agent_team_procedure_publications (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 procedure_id text NOT NULL,version_id text NOT NULL,
 approved_document jsonb NOT NULL,approved_by text NOT NULL REFERENCES users(id),
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 request_key text NOT NULL,request_hash text NOT NULL,
 FOREIGN KEY(workspace_id,procedure_id,version_id) REFERENCES stockchief_runtime.agent_team_procedure_versions(workspace_id,procedure_id,id) ON DELETE CASCADE,
 UNIQUE(workspace_id,request_key),UNIQUE(workspace_id,procedure_id,id)
);
CREATE INDEX agent_team_procedure_publication_procedure ON stockchief_runtime.agent_team_procedure_publications(procedure_id);
CREATE INDEX agent_team_procedure_publication_version ON stockchief_runtime.agent_team_procedure_publications(version_id);
CREATE INDEX agent_team_procedure_publication_source ON stockchief_runtime.agent_team_procedure_publications(workspace_id,procedure_id,version_id);
CREATE INDEX agent_team_procedure_publication_owner ON stockchief_runtime.agent_team_procedure_publications(approved_by);
CREATE INDEX agent_team_procedure_publication_history ON stockchief_runtime.agent_team_procedure_publications(workspace_id,procedure_id,approved_at DESC,id DESC);
CREATE TABLE stockchief_runtime.agent_team_procedure_current (
 procedure_id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,publication_id text NOT NULL,
 FOREIGN KEY(workspace_id,procedure_id,publication_id) REFERENCES stockchief_runtime.agent_team_procedure_publications(workspace_id,procedure_id,id) ON DELETE CASCADE
);
CREATE INDEX agent_team_procedure_current_publication ON stockchief_runtime.agent_team_procedure_current(publication_id);
CREATE INDEX agent_team_procedure_current_source ON stockchief_runtime.agent_team_procedure_current(workspace_id,procedure_id,publication_id);
CREATE INDEX agent_team_procedure_current_workspace ON stockchief_runtime.agent_team_procedure_current(workspace_id);
CREATE INDEX agent_procedure_receipt_history ON purchase_order_receipts(workspace_id,created_at DESC,id DESC);
CREATE INDEX agent_procedure_dispatch_history ON sales_shipments(workspace_id,created_at DESC,id DESC) WHERE status IN ('SHIPPED','DELIVERED');
CREATE INDEX agent_procedure_count_history ON warehouse_count_campaigns(workspace_id,completed_at DESC,id DESC) WHERE status='COMPLETED';
CREATE INDEX agent_procedure_dispatch_operation ON stockchief_runtime.business_operations(workspace_id,(result->>'salesOrderId')) WHERE kind='sales_order.fulfill' AND status='COMPLETED';
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_team_procedure_sets'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_team_procedure_versions'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_team_procedure_publications'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_team_procedure_current'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_team_procedure_sets'::regclass,'stockchief_runtime.agent_team_procedure_versions'::regclass,'stockchief_runtime.agent_team_procedure_publications'::regclass,'stockchief_runtime.agent_team_procedure_current'::regclass])r;
ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details','po-delivery-date','container-plan','team-procedure'));
