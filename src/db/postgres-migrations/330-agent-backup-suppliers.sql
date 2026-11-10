ALTER TABLE stockchief_runtime.supplier_link_submissions DROP CONSTRAINT supplier_link_submissions_kind_check;
ALTER TABLE stockchief_runtime.supplier_link_submissions ADD CONSTRAINT supplier_link_submissions_kind_check
 CHECK(kind IN('confirm','date','invoice','ship-notice','unavailable'));

CREATE TABLE stockchief_runtime.agent_backup_supplier_rules (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
 location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
 primary_supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
 backup_supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
 confirmation_days integer NOT NULL CHECK(confirmation_days BETWEEN 1 AND 90),
 backup_offer_hash text NOT NULL,
 currency text NOT NULL,
 maximum_goods_minor bigint NOT NULL CHECK(maximum_goods_minor>0),
 authorized_by text REFERENCES users(id) ON DELETE SET NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 enabled boolean NOT NULL DEFAULT false,
 taught_run_id text,
 problem text,
 next_check_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,sku_id,location_id),
 CHECK(primary_supplier_id<>backup_supplier_id)
);
CREATE INDEX backup_supplier_rule_sku ON stockchief_runtime.agent_backup_supplier_rules(sku_id);
CREATE INDEX backup_supplier_rule_location ON stockchief_runtime.agent_backup_supplier_rules(location_id);
CREATE INDEX backup_supplier_rule_primary ON stockchief_runtime.agent_backup_supplier_rules(primary_supplier_id);
CREATE INDEX backup_supplier_rule_backup ON stockchief_runtime.agent_backup_supplier_rules(backup_supplier_id);
CREATE INDEX backup_supplier_rule_actor ON stockchief_runtime.agent_backup_supplier_rules(authorized_by) WHERE authorized_by IS NOT NULL;
CREATE INDEX backup_supplier_rule_due ON stockchief_runtime.agent_backup_supplier_rules(workspace_id,next_check_at,id) WHERE enabled;

CREATE TABLE stockchief_runtime.agent_backup_supplier_notices (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
 location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
 purchase_order_id text REFERENCES purchase_orders(id) ON DELETE CASCADE,
 line_id text REFERENCES purchase_order_lines(id) ON DELETE CASCADE,
 supplier_reply_id text REFERENCES stockchief_runtime.supplier_link_submissions(id) ON DELETE SET NULL,
 recorded_by text REFERENCES users(id) ON DELETE SET NULL,
 evidence text NOT NULL,
 reference_quantity numeric NOT NULL CHECK(reference_quantity>0),
 secondary_quantity numeric CHECK(secondary_quantity>0),
 source_fingerprint text NOT NULL,
 reported_at timestamptz NOT NULL DEFAULT now(),
 valid_through date NOT NULL,
 revoked_at timestamptz,
 UNIQUE(workspace_id,source_fingerprint),
 CHECK((purchase_order_id IS NULL)=(line_id IS NULL))
);
CREATE INDEX backup_notice_order ON stockchief_runtime.agent_backup_supplier_notices(purchase_order_id);
CREATE INDEX backup_notice_line ON stockchief_runtime.agent_backup_supplier_notices(line_id,reported_at DESC);
CREATE INDEX backup_notice_reply ON stockchief_runtime.agent_backup_supplier_notices(supplier_reply_id) WHERE supplier_reply_id IS NOT NULL;
CREATE INDEX backup_notice_owner ON stockchief_runtime.agent_backup_supplier_notices(recorded_by) WHERE recorded_by IS NOT NULL;
CREATE INDEX backup_notice_active ON stockchief_runtime.agent_backup_supplier_notices(workspace_id,sku_id,location_id,supplier_id,reported_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX backup_notice_sku ON stockchief_runtime.agent_backup_supplier_notices(sku_id);
CREATE INDEX backup_notice_supplier ON stockchief_runtime.agent_backup_supplier_notices(supplier_id);
CREATE INDEX backup_notice_location ON stockchief_runtime.agent_backup_supplier_notices(location_id);

CREATE TABLE stockchief_runtime.agent_backup_supplier_runs (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 rule_id text NOT NULL REFERENCES stockchief_runtime.agent_backup_supplier_rules(id) ON DELETE CASCADE,
 purchase_order_id text REFERENCES purchase_orders(id) ON DELETE SET NULL,
 actor_id text REFERENCES users(id) ON DELETE SET NULL,
 trigger_key text NOT NULL,
 reason text NOT NULL,
 source_fingerprint text NOT NULL,
 facts jsonb NOT NULL,
 mode text NOT NULL CHECK(mode IN('human','automatic')),
 completed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,rule_id,trigger_key)
);
CREATE INDEX backup_supplier_run_rule ON stockchief_runtime.agent_backup_supplier_runs(rule_id);
CREATE INDEX backup_supplier_run_order ON stockchief_runtime.agent_backup_supplier_runs(purchase_order_id) WHERE purchase_order_id IS NOT NULL;
CREATE INDEX backup_supplier_run_actor ON stockchief_runtime.agent_backup_supplier_runs(actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX backup_supplier_run_history ON stockchief_runtime.agent_backup_supplier_runs(workspace_id,completed_at DESC,id);
ALTER TABLE stockchief_runtime.agent_backup_supplier_rules ADD CONSTRAINT agent_backup_supplier_taught_run
 FOREIGN KEY(taught_run_id) REFERENCES stockchief_runtime.agent_backup_supplier_runs(id) ON DELETE SET NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_backup_supplier_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_backup_supplier_notices'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_backup_supplier_runs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_backup_supplier_rules'::regclass,
 'stockchief_runtime.agent_backup_supplier_notices'::regclass,'stockchief_runtime.agent_backup_supplier_runs'::regclass);
