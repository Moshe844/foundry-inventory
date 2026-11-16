CREATE TABLE commercial_guarantee_requests (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(id),
 stripe_subscription_id TEXT NOT NULL UNIQUE,
 requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','PROCESSING','PENDING','REFUNDED','REVIEW')),
 parts JSONB NOT NULL DEFAULT '[]'::jsonb,
 last_error TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
