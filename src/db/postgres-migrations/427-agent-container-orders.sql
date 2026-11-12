-- Job 38: the owner's rule for filling an import container from real reorder
-- needs, and each container order the agent planned, drafted or sent.
CREATE TABLE stockchief_runtime.agent_container_order_rules (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id),
 destination_id text NOT NULL REFERENCES locations(id),
 currency text NOT NULL,
 container jsonb NOT NULL,
 fill_percent integer NOT NULL CHECK(fill_percent BETWEEN 1 AND 100),
 minimum_fill_percent integer NOT NULL CHECK(minimum_fill_percent BETWEEN 1 AND 100),
 cover_days integer NOT NULL CHECK(cover_days BETWEEN 1 AND 730),
 maximum_minor bigint NOT NULL CHECK(maximum_minor>0),
 enabled boolean NOT NULL DEFAULT false,
 authorized_by text NOT NULL REFERENCES users(id),
 taught_order_id text,
 training_signature text,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 next_check_at timestamptz,
 last_issue text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(minimum_fill_percent<=fill_percent),
 UNIQUE(workspace_id,supplier_id,destination_id)
);
CREATE INDEX agent_container_order_rule_supplier ON stockchief_runtime.agent_container_order_rules(supplier_id);
CREATE INDEX agent_container_order_rule_destination ON stockchief_runtime.agent_container_order_rules(destination_id);
CREATE INDEX agent_container_order_rule_owner ON stockchief_runtime.agent_container_order_rules(authorized_by);
CREATE INDEX agent_container_order_rule_due ON stockchief_runtime.agent_container_order_rules(workspace_id,next_check_at,id) WHERE enabled;

CREATE TABLE stockchief_runtime.agent_container_orders (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 rule_id text NOT NULL REFERENCES stockchief_runtime.agent_container_order_rules(id) ON DELETE CASCADE,
 rule_revision integer NOT NULL,
 source_fingerprint text NOT NULL,
 plan jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('NEEDS_FACTS','WATCHED','DRAFTED','SENT','UNDONE')),
 reason text,
 purchase_order_id text REFERENCES purchase_orders(id),
 automatic boolean NOT NULL DEFAULT false,
 communication_id text,
 effect_id text,
 created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 undone_at timestamptz,
 undone_by text REFERENCES users(id),
 CHECK(status NOT IN ('DRAFTED','SENT','UNDONE') OR purchase_order_id IS NOT NULL),
 UNIQUE(rule_id,source_fingerprint)
);
CREATE INDEX agent_container_order_workspace ON stockchief_runtime.agent_container_orders(workspace_id,rule_id,created_at DESC,id DESC);
CREATE INDEX agent_container_order_po ON stockchief_runtime.agent_container_orders(purchase_order_id);
CREATE INDEX agent_container_order_creator ON stockchief_runtime.agent_container_orders(created_by);
CREATE INDEX agent_container_order_undoer ON stockchief_runtime.agent_container_orders(undone_by) WHERE undone_by IS NOT NULL;
ALTER TABLE stockchief_runtime.agent_container_order_rules ADD FOREIGN KEY(taught_order_id) REFERENCES stockchief_runtime.agent_container_orders(id) ON DELETE SET NULL;
CREATE INDEX agent_container_order_rule_example ON stockchief_runtime.agent_container_order_rules(taught_order_id);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_container_order_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_container_orders'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables r
 WHERE r.relation IN ('stockchief_runtime.agent_container_order_rules'::regclass,'stockchief_runtime.agent_container_orders'::regclass);
