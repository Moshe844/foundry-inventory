CREATE TABLE IF NOT EXISTS support_requests (
 id TEXT PRIMARY KEY,
 account_id TEXT REFERENCES accounts(id),
 workspace_id TEXT REFERENCES workspaces(id),
 request_key TEXT NOT NULL UNIQUE,
 contact_email TEXT NOT NULL,
 subject TEXT NOT NULL,
 body TEXT NOT NULL,
 source_path TEXT,
 requester_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK(status IN ('RECEIVED','IN_REVIEW','RESOLVED')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_requests_account ON support_requests(account_id,created_at DESC);
CREATE INDEX IF NOT EXISTS support_requests_rate ON support_requests(requester_hash,created_at DESC);
