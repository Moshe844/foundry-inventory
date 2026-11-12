-- Job 61: the owner's rules for splitting an order that is partly in stock,
-- which customers and orders accept partial shipments, and every split
-- StockChief prepared or applied. A split links the original order, the
-- shipment that went to picking and the part that still waits on that order.
CREATE TABLE stockchief_runtime.agent_split_rules (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 authorized_by text REFERENCES users(id) ON DELETE SET NULL,
 customers text NOT NULL CHECK(customers IN ('accepting','all')),
 min_percent integer NOT NULL DEFAULT 0 CHECK(min_percent BETWEEN 0 AND 99),
 min_value_minor bigint NOT NULL DEFAULT 0 CHECK(min_value_minor BETWEEN 0 AND 100000000000),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 max_splits integer NOT NULL CHECK(max_splits BETWEEN 1 AND 10),
 notify text NOT NULL DEFAULT 'off' CHECK(notify IN ('off','send')),
 connector_id text,
 mailbox_account text,
 enabled boolean NOT NULL DEFAULT true,
 automatic boolean NOT NULL DEFAULT false,
 taught_split_id text,
 taught_revision integer,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((taught_split_id IS NULL)=(taught_revision IS NULL)),
 CHECK(notify='off' OR (connector_id IS NOT NULL AND mailbox_account IS NOT NULL))
);
CREATE INDEX agent_split_rule_owner ON stockchief_runtime.agent_split_rules(authorized_by) WHERE authorized_by IS NOT NULL;

-- Whether a customer, or one order, accepts partial shipments. An order's own
-- answer comes before its customer's.
CREATE TABLE stockchief_runtime.agent_split_consents (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 customer_id text REFERENCES customers(id) ON DELETE CASCADE,
 sales_order_id text REFERENCES sales_orders(id) ON DELETE CASCADE,
 accepts boolean NOT NULL,
 updated_by text REFERENCES users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((customer_id IS NULL)<>(sales_order_id IS NULL))
);
CREATE UNIQUE INDEX agent_split_consent_customer ON stockchief_runtime.agent_split_consents(workspace_id,customer_id) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX agent_split_consent_order ON stockchief_runtime.agent_split_consents(workspace_id,sales_order_id) WHERE sales_order_id IS NOT NULL;
CREATE INDEX agent_split_consent_customer_ref ON stockchief_runtime.agent_split_consents(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX agent_split_consent_order_ref ON stockchief_runtime.agent_split_consents(sales_order_id) WHERE sales_order_id IS NOT NULL;
CREATE INDEX agent_split_consent_editor ON stockchief_runtime.agent_split_consents(updated_by) WHERE updated_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_order_splits (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sales_order_id text NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
 location_id text NOT NULL REFERENCES locations(id),
 status text NOT NULL CHECK(status IN ('DRAFT','APPLIED','UNDONE','DISCARDED','STALE')),
 authorization_kind text CHECK(authorization_kind IN ('INDIVIDUAL','AUTOMATIC')),
 plan jsonb NOT NULL,
 fingerprint text NOT NULL,
 rule_revision integer,
 request_key text NOT NULL,
 reason text,
 shipment_id text REFERENCES sales_shipments(id) ON DELETE SET NULL,
 notice_id text,
 notice_problem text,
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
-- One split waiting for approval per order.
CREATE UNIQUE INDEX agent_order_split_open ON stockchief_runtime.agent_order_splits(workspace_id,sales_order_id) WHERE status='DRAFT';
CREATE INDEX agent_order_split_order ON stockchief_runtime.agent_order_splits(sales_order_id);
CREATE INDEX agent_order_split_recent ON stockchief_runtime.agent_order_splits(workspace_id,created_at DESC,id);
CREATE INDEX agent_order_split_location ON stockchief_runtime.agent_order_splits(location_id);
CREATE INDEX agent_order_split_shipment ON stockchief_runtime.agent_order_splits(shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX agent_order_split_preparer ON stockchief_runtime.agent_order_splits(prepared_by) WHERE prepared_by IS NOT NULL;
CREATE INDEX agent_order_split_applier ON stockchief_runtime.agent_order_splits(applied_by) WHERE applied_by IS NOT NULL;
CREATE INDEX agent_order_split_undoer ON stockchief_runtime.agent_order_splits(undone_by) WHERE undone_by IS NOT NULL;

ALTER TABLE stockchief_runtime.agent_split_rules ADD CONSTRAINT agent_split_rule_example
 FOREIGN KEY(taught_split_id) REFERENCES stockchief_runtime.agent_order_splits(id) ON DELETE SET NULL;
CREATE INDEX agent_split_rule_example_ref ON stockchief_runtime.agent_split_rules(taught_split_id) WHERE taught_split_id IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_split_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_split_consents'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_order_splits'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_split_rules'::regclass,'stockchief_runtime.agent_split_consents'::regclass,
  'stockchief_runtime.agent_order_splits'::regclass);
