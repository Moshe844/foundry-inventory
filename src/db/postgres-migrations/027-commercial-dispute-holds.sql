ALTER TABLE commercial_usage_grants ADD COLUMN dispute_hold_units BIGINT NOT NULL DEFAULT 0
 CHECK(dispute_hold_units>=0 AND dispute_hold_units<=units);
CREATE TABLE commercial_usage_disputes (
 id TEXT PRIMARY KEY,
 purchase_id TEXT NOT NULL REFERENCES commercial_usage_purchases(id),
 amount_minor BIGINT NOT NULL CHECK(amount_minor>0),
 currency TEXT NOT NULL,
 status TEXT NOT NULL,
 provider_created_at TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commercial_purchase_disputes ON commercial_usage_disputes(purchase_id);
