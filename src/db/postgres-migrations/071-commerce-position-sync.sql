CREATE TABLE IF NOT EXISTS connection_commerce_positions (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 connector_id TEXT NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
 provider_account_id TEXT,
 provider_type TEXT,
 sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
 location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
 external_id TEXT NOT NULL,
 parent_external_id TEXT,
 external_location_id TEXT NOT NULL,
 field TEXT NOT NULL CHECK(field IN ('price','quantity')),
 mode TEXT NOT NULL CHECK(mode IN ('off','inbound','outbound','two_way')),
 revision INTEGER NOT NULL DEFAULT 1,
 baseline_local JSONB,
 baseline_provider JSONB,
 pending_effect_id TEXT,
 authorized_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 last_verified_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,connector_id,sku_id,location_id,field)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_price_position ON connection_commerce_positions(workspace_id,connector_id,sku_id) WHERE field='price' AND mode<>'off';
CREATE INDEX IF NOT EXISTS ix_commerce_positions_connector ON connection_commerce_positions(workspace_id,connector_id) WHERE mode<>'off';
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_outbound_authority ON connection_commerce_positions(provider_type,provider_account_id,external_id,(CASE WHEN field='price' THEN '' ELSE external_location_id END),field) WHERE mode IN ('outbound','two_way') AND provider_account_id IS NOT NULL AND provider_type IS NOT NULL;
