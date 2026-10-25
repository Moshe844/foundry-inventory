CREATE TABLE cardknox_checkout_sessions (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 request_id text NOT NULL UNIQUE REFERENCES payment_requests(id) ON DELETE RESTRICT,
 connector_id text NOT NULL REFERENCES workspace_connectors(id) ON DELETE RESTRICT,merchant_account_id text NOT NULL,
 token_hash text NOT NULL UNIQUE,token_cipher jsonb NOT NULL,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cardknox_payment_attempts (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 session_id text NOT NULL UNIQUE REFERENCES cardknox_checkout_sessions(id) ON DELETE RESTRICT,
 status text NOT NULL CHECK(status IN ('PENDING','APPROVED','DECLINED','UNKNOWN')),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),currency text NOT NULL,
 external_payment_id text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cardknox_payment_reference ON cardknox_payment_attempts(workspace_id,external_payment_id) WHERE external_payment_id IS NOT NULL;
