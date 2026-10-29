-- Additive only. Existing accounts, subscriptions, support and business records stay authoritative.
CREATE TABLE platform_console_operators (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id),
 role TEXT NOT NULL CHECK(role IN ('OWNER','SUPPORT','BILLING')),
 active BOOLEAN NOT NULL DEFAULT true,
 granted_by TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO platform_console_operators(account_id,role,granted_by)
 SELECT account_id,'OWNER','Existing explicit platform administrator'
 FROM commercial_admin_accounts ON CONFLICT DO NOTHING;
CREATE TABLE platform_console_mfa (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id),
 sealed_secret JSONB NOT NULL,
 last_counter BIGINT NOT NULL,
 enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE platform_console_challenges (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
 sealed_secret JSONB, expires_at TIMESTAMPTZ NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 consumed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX platform_console_challenge_expiry ON platform_console_challenges(expires_at);
CREATE TABLE platform_support_access (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES support_requests(id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 operator_account_id TEXT NOT NULL REFERENCES accounts(id),
 scopes TEXT[] NOT NULL CHECK(cardinality(scopes)>0 AND scopes <@ ARRAY['stock','orders','purchasing','money']::TEXT[]),
 reason TEXT NOT NULL, request_key TEXT NOT NULL, duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 5 AND 60),
 status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','APPROVED','REVOKED')),
 approved_by TEXT REFERENCES accounts(id), approved_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
 revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(operator_account_id,request_key)
);
CREATE INDEX platform_support_access_ticket ON platform_support_access(request_id,created_at DESC);
