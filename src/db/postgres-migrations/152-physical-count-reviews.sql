CREATE TABLE physical_count_reviews (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 created_by_user_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED','CANCELLED')),
 payload JSONB NOT NULL,
 integrity_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 approved_at TIMESTAMPTZ,
 approved_by_user_id TEXT,
 result JSONB
);
CREATE INDEX physical_count_reviews_workspace ON physical_count_reviews(workspace_id,created_at DESC);
