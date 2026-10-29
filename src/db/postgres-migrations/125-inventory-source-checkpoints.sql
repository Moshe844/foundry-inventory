-- Absolute source positions need monotonic checkpoints as well as event-id replay safety.
CREATE TABLE stockchief_runtime.inventory_source_checkpoints (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 connector_id TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
 sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
 location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
 source_version NUMERIC(40,0),
 source_time TIMESTAMPTZ,
 event_id TEXT NOT NULL,
 counted_quantity NUMERIC NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,connector_id,sku_id,location_id),
 CHECK(source_version IS NOT NULL OR source_time IS NOT NULL)
);
