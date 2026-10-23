ALTER TABLE sales_shipments ADD COLUMN shipping_options JSONB NOT NULL DEFAULT '{}';
ALTER TABLE sales_shipments ADD COLUMN shipping_documents JSONB NOT NULL DEFAULT '[]';
ALTER TABLE sales_shipments ADD COLUMN provider_packages JSONB NOT NULL DEFAULT '[]';
ALTER TABLE shipment_tracking_events ADD COLUMN tracking_number TEXT;
CREATE TABLE shipping_package_presets (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 name TEXT NOT NULL,
 packages JSONB NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(workspace_id,id)
);
CREATE UNIQUE INDEX shipping_package_preset_names ON shipping_package_presets(workspace_id,lower(name));
