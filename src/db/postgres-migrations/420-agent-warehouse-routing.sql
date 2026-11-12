-- Job 121: the owner's rules for choosing the warehouse that ships each
-- order, each warehouse's saved priority and cost, and every choice
-- StockChief prepared, applied, asked about or had undone.
CREATE TABLE stockchief_runtime.agent_warehouse_routing_rules (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 authorized_by text REFERENCES users(id) ON DELETE SET NULL,
 criteria text[] NOT NULL CHECK(cardinality(criteria) BETWEEN 1 AND 3 AND criteria <@ ARRAY['nearest','priority','cheapest']::text[]),
 split_rule text NOT NULL CHECK(split_rule IN ('never','faster')),
 max_warehouses integer NOT NULL DEFAULT 2 CHECK(max_warehouses BETWEEN 2 AND 5),
 max_units integer NOT NULL CHECK(max_units BETWEEN 1 AND 1000000),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 enabled boolean NOT NULL DEFAULT true,
 automatic boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_warehouse_routing_rule_owner ON stockchief_runtime.agent_warehouse_routing_rules(authorized_by) WHERE authorized_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_warehouse_routing_sites (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
 ships boolean NOT NULL DEFAULT true,
 priority integer NOT NULL CHECK(priority BETWEEN 1 AND 1000),
 cost_minor bigint CHECK(cost_minor IS NULL OR cost_minor BETWEEN 0 AND 100000000000),
 updated_by text REFERENCES users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,location_id)
);
CREATE INDEX agent_warehouse_routing_site_location ON stockchief_runtime.agent_warehouse_routing_sites(location_id);
CREATE INDEX agent_warehouse_routing_site_editor ON stockchief_runtime.agent_warehouse_routing_sites(updated_by) WHERE updated_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_warehouse_routings (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sales_order_id text NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('DRAFT','ASK','KEPT','APPLIED','UNDONE','DISCARDED','STALE')),
 authorization_kind text CHECK(authorization_kind IN ('INDIVIDUAL','AUTOMATIC')),
 plan jsonb NOT NULL,
 fingerprint text NOT NULL,
 rule_revision integer,
 request_key text NOT NULL,
 reason text,
 prepared_by text REFERENCES users(id) ON DELETE SET NULL,
 applied_by text REFERENCES users(id) ON DELETE SET NULL,
 applied_at timestamptz,
 undone_by text REFERENCES users(id) ON DELETE SET NULL,
 undone_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,request_key),
 CHECK((status IN ('APPLIED','UNDONE'))=(applied_at IS NOT NULL AND authorization_kind IS NOT NULL)),
 CHECK((status='UNDONE')=(undone_at IS NOT NULL))
);
-- One open question or draft, one quiet check and one applied choice per order.
CREATE UNIQUE INDEX agent_warehouse_routing_open ON stockchief_runtime.agent_warehouse_routings(workspace_id,sales_order_id) WHERE status IN ('DRAFT','ASK');
CREATE UNIQUE INDEX agent_warehouse_routing_kept ON stockchief_runtime.agent_warehouse_routings(workspace_id,sales_order_id) WHERE status='KEPT';
CREATE UNIQUE INDEX agent_warehouse_routing_applied ON stockchief_runtime.agent_warehouse_routings(workspace_id,sales_order_id) WHERE status='APPLIED';
CREATE INDEX agent_warehouse_routing_order ON stockchief_runtime.agent_warehouse_routings(sales_order_id);
CREATE INDEX agent_warehouse_routing_recent ON stockchief_runtime.agent_warehouse_routings(workspace_id,created_at DESC,id);
CREATE INDEX agent_warehouse_routing_preparer ON stockchief_runtime.agent_warehouse_routings(prepared_by) WHERE prepared_by IS NOT NULL;
CREATE INDEX agent_warehouse_routing_applier ON stockchief_runtime.agent_warehouse_routings(applied_by) WHERE applied_by IS NOT NULL;
CREATE INDEX agent_warehouse_routing_undoer ON stockchief_runtime.agent_warehouse_routings(undone_by) WHERE undone_by IS NOT NULL;

-- Choices waiting for a person appear in Needs you as soon as they change.
CREATE TRIGGER read_model_insert AFTER INSERT ON stockchief_runtime.agent_warehouse_routings REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
CREATE TRIGGER read_model_update AFTER UPDATE ON stockchief_runtime.agent_warehouse_routings REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
CREATE TRIGGER read_model_delete AFTER DELETE ON stockchief_runtime.agent_warehouse_routings REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_warehouse_routing_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_warehouse_routing_sites'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_warehouse_routings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_warehouse_routing_rules'::regclass,'stockchief_runtime.agent_warehouse_routing_sites'::regclass,
  'stockchief_runtime.agent_warehouse_routings'::regclass);
