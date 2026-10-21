CREATE TABLE IF NOT EXISTS catalog_bulk_reviews (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 created_by_user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('archive','restore','price')),
 payload JSONB NOT NULL,
 integrity_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','COMPLETED','CANCELLED')),
 created_at TEXT NOT NULL,
 approved_at TEXT,
 approved_by_user_id TEXT REFERENCES users(id)
);
