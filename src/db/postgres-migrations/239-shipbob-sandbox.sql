CREATE TABLE stockchief_runtime.shipbob_sandbox_orders (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sales_order_id text NOT NULL REFERENCES sales_orders(id),
  connector_id text NOT NULL REFERENCES workspace_connectors(id),
  channel_id text NOT NULL, request_hash text NOT NULL,
  provider_order_id text, provider_status text, shipments jsonb NOT NULL DEFAULT '[]',
  prepared_by text NOT NULL REFERENCES users(id), observed_at timestamptz,
  PRIMARY KEY (workspace_id,sales_order_id)
);
CREATE TABLE stockchief_runtime.shipbob_sandbox_stock (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id text NOT NULL REFERENCES skus(id),
  inventory_id text NOT NULL, connector_id text NOT NULL REFERENCES workspace_connectors(id),
  on_hand integer NOT NULL, fulfillable integer NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,sku_id), UNIQUE(workspace_id,inventory_id)
);
CREATE TABLE stockchief_runtime.shipbob_sandbox_rules (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  location_id text NOT NULL REFERENCES locations(id), actor_id text NOT NULL REFERENCES users(id),
  generation text NOT NULL, enabled_at timestamptz NOT NULL DEFAULT now()
);
