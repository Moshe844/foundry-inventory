-- Job 186: orders go to the 3PL that runs a warehouse, and its shipping,
-- tracking and stock come back.
--
-- A route says one StockChief warehouse is run by one connected 3PL. Orders
-- confirmed to ship from it go to that 3PL: on their own when the owner allows
-- it (Pro and Custom), or drafted for a person (Growth). Each enabled route is
-- one saved rule.
CREATE TABLE stockchief_runtime.agent_3pl_routes (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  location_id text NOT NULL REFERENCES locations(id),
  connector_id text NOT NULL REFERENCES workspace_connectors(id),
  automatic boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  authorized_by text NOT NULL REFERENCES users(id),
  enabled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,location_id)
);
CREATE INDEX agent_3pl_route_connector ON stockchief_runtime.agent_3pl_routes(connector_id);
CREATE INDEX agent_3pl_route_location ON stockchief_runtime.agent_3pl_routes(location_id);
CREATE INDEX agent_3pl_route_owner ON stockchief_runtime.agent_3pl_routes(authorized_by);

-- Each routed order: drafted for a person, held because a fact is missing or
-- does not match, being sent (the outcome is not yet confirmed), sent, or
-- dismissed. The order version it was worked out for is kept, so a changed
-- order is looked at again. The shared delegation record that keeps local
-- picking away from an order is stockchief_runtime.shipbob_sandbox_orders,
-- written for every 3PL when an order is handed over.
CREATE TABLE stockchief_runtime.agent_3pl_orders (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sales_order_id text NOT NULL REFERENCES sales_orders(id),
  connector_id text NOT NULL REFERENCES workspace_connectors(id),
  location_id text NOT NULL REFERENCES locations(id),
  order_version integer NOT NULL,
  request_hash text,
  status text NOT NULL CHECK (status IN ('DRAFT','HELD','SENDING','SENT','DISMISSED')),
  reason text,
  automatic boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  sent_at timestamptz,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,sales_order_id)
);
CREATE INDEX agent_3pl_order_status ON stockchief_runtime.agent_3pl_orders(workspace_id,status,updated_at);
CREATE INDEX agent_3pl_order_sales_order ON stockchief_runtime.agent_3pl_orders(sales_order_id);
CREATE INDEX agent_3pl_order_connector ON stockchief_runtime.agent_3pl_orders(connector_id);
CREATE INDEX agent_3pl_order_location ON stockchief_runtime.agent_3pl_orders(location_id);
CREATE INDEX agent_3pl_order_person ON stockchief_runtime.agent_3pl_orders(decided_by) WHERE decided_by IS NOT NULL;

-- Each shipment the 3PL reports, and the StockChief shipment it became. One
-- that waits for a person (Growth, or StockChief may not act now) or holds
-- because it does not match the order is recorded only when that is settled.
CREATE TABLE stockchief_runtime.agent_3pl_parcels (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES workspace_connectors(id),
  provider_shipment_id text NOT NULL CHECK (length(provider_shipment_id) BETWEEN 1 AND 120),
  sales_order_id text NOT NULL REFERENCES sales_orders(id),
  status text NOT NULL CHECK (status IN ('WAITING','HELD','RECORDED')),
  reason text,
  carrier text,
  tracking_number text,
  shipped_at timestamptz,
  lines jsonb NOT NULL,
  shipment_id text REFERENCES sales_shipments(id),
  automatic boolean NOT NULL DEFAULT false,
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_at timestamptz,
  PRIMARY KEY (workspace_id,connector_id,provider_shipment_id)
);
CREATE INDEX agent_3pl_parcel_open ON stockchief_runtime.agent_3pl_parcels(workspace_id,status) WHERE status<>'RECORDED';
CREATE INDEX agent_3pl_parcel_connector ON stockchief_runtime.agent_3pl_parcels(connector_id);
CREATE INDEX agent_3pl_parcel_order ON stockchief_runtime.agent_3pl_parcels(sales_order_id);
CREATE INDEX agent_3pl_parcel_shipment ON stockchief_runtime.agent_3pl_parcels(shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX agent_3pl_parcel_person ON stockchief_runtime.agent_3pl_parcels(decided_by) WHERE decided_by IS NOT NULL;

-- Stock a 3PL reports for one product. ShipBob sandbox readings keep their
-- own table (shipbob_sandbox_stock), which the partner stock view already reads.
CREATE TABLE stockchief_runtime.agent_3pl_stock (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES workspace_connectors(id),
  sku_id text NOT NULL REFERENCES skus(id),
  inventory_ref text NOT NULL CHECK (length(inventory_ref) BETWEEN 1 AND 120),
  on_hand integer NOT NULL CHECK (on_hand>=0),
  available integer NOT NULL CHECK (available>=0),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,connector_id,sku_id)
);
CREATE INDEX agent_3pl_stock_connector ON stockchief_runtime.agent_3pl_stock(connector_id);
CREATE INDEX agent_3pl_stock_sku ON stockchief_runtime.agent_3pl_stock(sku_id);
CREATE INDEX agent_3pl_stock_due ON stockchief_runtime.agent_3pl_stock(observed_at,workspace_id);

-- The older single ShipBob warehouse rule becomes a route that sends on its own.
INSERT INTO stockchief_runtime.agent_3pl_routes(workspace_id,location_id,connector_id,automatic,authorized_by,enabled_at)
SELECT r.workspace_id,r.location_id,c.id,true,r.actor_id,r.enabled_at FROM stockchief_runtime.shipbob_sandbox_rules r
JOIN workspace_connectors c ON c.workspace_id=r.workspace_id AND c.connector_key='agent-shipbob-sandbox'
ON CONFLICT DO NOTHING;
DELETE FROM stockchief_runtime.shipbob_sandbox_rules;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_3pl_routes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_3pl_orders'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_3pl_parcels'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_3pl_stock'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation IN ('stockchief_runtime.agent_3pl_routes'::regclass,'stockchief_runtime.agent_3pl_orders'::regclass,
    'stockchief_runtime.agent_3pl_parcels'::regclass,'stockchief_runtime.agent_3pl_stock'::regclass);
