-- First-class kits / bills of materials.
--
-- A kit SKU is what the customer buys. Its components are the physical stock
-- StockChief reserves, picks, ships and receives back. Definitions are copied to
-- order/return snapshots so changing a kit tomorrow never rewrites history.

CREATE TABLE IF NOT EXISTS kit_components (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kit_sku_id         TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  component_sku_id   TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  quantity           INTEGER NOT NULL CHECK (quantity > 0),
  stock_basis        TEXT NOT NULL DEFAULT 'components'
                       CHECK (stock_basis IN ('components','preassembled')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (kit_sku_id, component_sku_id),
  CHECK (kit_sku_id <> component_sku_id)
);
CREATE INDEX IF NOT EXISTS idx_kit_components_component
  ON kit_components(workspace_id, component_sku_id);

CREATE TABLE IF NOT EXISTS sales_order_kit_components (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sales_order_line_id   TEXT NOT NULL REFERENCES sales_order_lines(id) ON DELETE CASCADE,
  component_sku_id      TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  quantity_per_kit      INTEGER NOT NULL CHECK (quantity_per_kit > 0),
  quantity_required     INTEGER NOT NULL CHECK (quantity_required > 0),
  quantity_fulfilled    INTEGER NOT NULL DEFAULT 0 CHECK (quantity_fulfilled >= 0),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (sales_order_line_id, component_sku_id),
  CHECK (quantity_fulfilled <= quantity_required)
);

CREATE TABLE IF NOT EXISTS sales_order_kit_allocations (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kit_component_id      TEXT NOT NULL REFERENCES sales_order_kit_components(id) ON DELETE CASCADE,
  location_id           TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  quantity              INTEGER NOT NULL CHECK (quantity > 0),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (kit_component_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_kit_allocations_position
  ON sales_order_kit_allocations(workspace_id, location_id, kit_component_id);

CREATE TABLE IF NOT EXISTS sales_shipment_kit_lines (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shipment_id           TEXT NOT NULL REFERENCES sales_shipments(id) ON DELETE CASCADE,
  kit_component_id      TEXT NOT NULL REFERENCES sales_order_kit_components(id) ON DELETE CASCADE,
  sales_order_line_id   TEXT NOT NULL REFERENCES sales_order_lines(id) ON DELETE CASCADE,
  sku_id                TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  location_id           TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  quantity              INTEGER NOT NULL CHECK (quantity > 0),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (shipment_id, kit_component_id, location_id)
);

CREATE TABLE IF NOT EXISTS customer_return_kit_components (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_return_line_id TEXT NOT NULL REFERENCES customer_return_lines(id) ON DELETE CASCADE,
  component_sku_id      TEXT NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  quantity_per_kit      INTEGER NOT NULL CHECK (quantity_per_kit > 0),
  quantity_authorized   INTEGER NOT NULL CHECK (quantity_authorized > 0),
  quantity_received     INTEGER NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  quantity_restocked    INTEGER NOT NULL DEFAULT 0 CHECK (quantity_restocked >= 0),
  quantity_scrapped     INTEGER NOT NULL DEFAULT 0 CHECK (quantity_scrapped >= 0),
  quantity_repair       INTEGER NOT NULL DEFAULT 0 CHECK (quantity_repair >= 0),
  receive_movement_ids  TEXT NOT NULL DEFAULT '[]',
  disposition_movement_ids TEXT NOT NULL DEFAULT '[]',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (customer_return_line_id, component_sku_id)
);
