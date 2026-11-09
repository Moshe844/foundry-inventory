CREATE TABLE stockchief_runtime.agent_container_pack_profiles (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 scope_hash text NOT NULL,
 supplier_id text NOT NULL REFERENCES suppliers(id),
 sku_id text NOT NULL REFERENCES skus(id),
 identity jsonb NOT NULL,
 pack jsonb NOT NULL,
 source_reference text NOT NULL,
 profile_hash text NOT NULL,
 verified_by text NOT NULL REFERENCES users(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,scope_hash)
);
CREATE INDEX agent_container_pack_supplier ON stockchief_runtime.agent_container_pack_profiles(supplier_id);
CREATE INDEX agent_container_pack_sku ON stockchief_runtime.agent_container_pack_profiles(sku_id);
CREATE INDEX agent_container_pack_owner ON stockchief_runtime.agent_container_pack_profiles(verified_by);
CREATE TABLE stockchief_runtime.agent_container_projects (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 title text NOT NULL,
 order_ids jsonb NOT NULL,
 container_spec jsonb NOT NULL,
 package_profiles jsonb NOT NULL,
 authority_scope jsonb NOT NULL,
 authorized_by text NOT NULL REFERENCES users(id),
 enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 request_key text NOT NULL,
 request_hash text NOT NULL,
 last_checked_at timestamptz,
 last_issue text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,request_key)
);
CREATE INDEX agent_container_project_owner ON stockchief_runtime.agent_container_projects(authorized_by);
CREATE INDEX agent_container_project_workspace ON stockchief_runtime.agent_container_projects(workspace_id,created_at,id);
CREATE INDEX agent_container_project_due ON stockchief_runtime.agent_container_projects(workspace_id,last_checked_at,id) WHERE enabled;
CREATE TABLE stockchief_runtime.agent_container_runs (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 project_id text NOT NULL REFERENCES stockchief_runtime.agent_container_projects(id) ON DELETE CASCADE,
 source_fingerprint text NOT NULL,
 source_snapshot jsonb NOT NULL,
 result jsonb NOT NULL,
 automatic boolean NOT NULL,
 created_by text NOT NULL REFERENCES users(id),
 reviewed_by text REFERENCES users(id),
 reviewed_at timestamptz,
 completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(NOT automatic OR completed_at IS NOT NULL),
 UNIQUE(project_id,source_fingerprint)
);
CREATE INDEX agent_container_run_workspace ON stockchief_runtime.agent_container_runs(workspace_id,created_at,id);
CREATE INDEX agent_container_run_owner ON stockchief_runtime.agent_container_runs(created_by);
CREATE INDEX agent_container_run_reviewer ON stockchief_runtime.agent_container_runs(reviewed_by);
CREATE INDEX agent_container_run_completed ON stockchief_runtime.agent_container_runs(workspace_id,completed_at,id) WHERE completed_at IS NOT NULL;
CREATE TABLE stockchief_runtime.agent_container_rules (
 project_id text PRIMARY KEY REFERENCES stockchief_runtime.agent_container_projects(id) ON DELETE CASCADE,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 authority_scope jsonb NOT NULL,
 authorized_by text NOT NULL REFERENCES users(id),
 example_run_id text NOT NULL REFERENCES stockchief_runtime.agent_container_runs(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE INDEX agent_container_rule_workspace ON stockchief_runtime.agent_container_rules(workspace_id);
CREATE INDEX agent_container_rule_owner ON stockchief_runtime.agent_container_rules(authorized_by);
CREATE INDEX agent_container_rule_example ON stockchief_runtime.agent_container_rules(example_run_id);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_container_pack_profiles'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_container_projects'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_container_runs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_container_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_container_pack_profiles'::regclass,'stockchief_runtime.agent_container_projects'::regclass,'stockchief_runtime.agent_container_runs'::regclass,'stockchief_runtime.agent_container_rules'::regclass])r;
ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details','po-delivery-date','container-plan'));
