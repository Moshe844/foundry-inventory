CREATE TABLE variant_change_reviews (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','COMPLETED','CANCELLED')),
 payload JSONB NOT NULL,
 integrity_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 approved_at TIMESTAMPTZ,
 approved_by_user_id TEXT
);
CREATE INDEX variant_change_reviews_inventory_status ON variant_change_reviews(workspace_id,status,created_at DESC);
