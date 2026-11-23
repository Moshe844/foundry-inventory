-- A 6-digit code emailed at sign-in. Only a keyed hash of the code is kept.
CREATE TABLE sign_in_codes (
 id text PRIMARY KEY,
 account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 code_hash text NOT NULL,
 requested_ip text,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sign_in_codes_account_time ON sign_in_codes(account_id,created_at DESC);
CREATE INDEX sign_in_codes_expiry ON sign_in_codes(expires_at);

-- A browser the owner asked to remember: no code is asked there until expires_at.
-- The browser holds a random token; only its hash is kept.
CREATE TABLE trusted_sign_in_devices (
 id text PRIMARY KEY,
 account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE,
 browser text,
 created_at timestamptz NOT NULL DEFAULT now(),
 last_used_at timestamptz,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz
);
CREATE INDEX trusted_sign_in_devices_account ON trusted_sign_in_devices(account_id,expires_at);
