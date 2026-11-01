CREATE TABLE kit_recipe_reviews(
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),kit_sku_id TEXT NOT NULL REFERENCES skus(id),
 actor_id TEXT NOT NULL REFERENCES users(id),payload JSONB NOT NULL,integrity_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','COMPLETED')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),completed_at TIMESTAMPTZ
);
CREATE INDEX kit_recipe_reviews_inventory ON kit_recipe_reviews(workspace_id,kit_sku_id,created_at DESC);
