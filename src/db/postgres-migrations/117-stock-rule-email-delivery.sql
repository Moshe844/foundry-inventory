-- Additive: existing Needs You stock rules retain their current behavior.
ALTER TABLE stockchief_runtime.stock_threshold_rules ADD COLUMN notification_settings JSONB;
ALTER TABLE stockchief_runtime.stock_threshold_rules ADD COLUMN crossing_version BIGINT NOT NULL DEFAULT 0;
CREATE TABLE stockchief_runtime.stock_threshold_deliveries (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 rule_id TEXT NOT NULL REFERENCES stockchief_runtime.stock_threshold_rules(id),
 crossing_version BIGINT NOT NULL,configuration_hash TEXT NOT NULL,observation JSONB NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PENDING','HELD','QUEUED','CANCELLED')),
 communication_id TEXT,communication_kind TEXT,effect_id TEXT,last_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(rule_id,crossing_version)
);
CREATE INDEX stock_threshold_delivery_pending ON stockchief_runtime.stock_threshold_deliveries(workspace_id,status,created_at) WHERE status IN ('PENDING','HELD');
