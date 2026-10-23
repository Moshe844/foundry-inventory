CREATE TABLE shipping_tracking_checks (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 shipment_id TEXT NOT NULL REFERENCES sales_shipments(id),
 next_check_at TEXT NOT NULL,
 last_checked_at TEXT,
 last_error TEXT,
 failures INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,shipment_id)
);
CREATE INDEX shipping_tracking_due ON shipping_tracking_checks(next_check_at);
CREATE TABLE shipping_webhook_setups (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 connector_id TEXT NOT NULL REFERENCES workspace_connectors(id),
 status TEXT NOT NULL CHECK(status IN ('PENDING','CONNECTED','POLLING','REVIEW')),
 provider_reference TEXT,
 last_error TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,connector_id)
);
