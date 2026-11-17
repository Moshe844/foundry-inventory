-- A short-lived, browser-bound Shopify consent handoff. No workspace, paid
-- subscription or business connection is created until its owner confirms.
CREATE TABLE shopify_public_installs (
 id TEXT PRIMARY KEY,
 state_hash TEXT NOT NULL UNIQUE,
 browser_hash TEXT NOT NULL,
 shop TEXT NOT NULL,
 client_id TEXT NOT NULL,
 metadata TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('AUTHORIZING','EXCHANGING','AUTHORIZED','LINKED','FAILED')),
 ciphertext TEXT,
 iv TEXT,
 auth_tag TEXT,
 linked_workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
 linked_connector_id TEXT,
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK ((ciphertext IS NULL AND iv IS NULL AND auth_tag IS NULL) OR
        (ciphertext IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL))
);
CREATE INDEX shopify_public_installs_expiry ON shopify_public_installs(expires_at);
