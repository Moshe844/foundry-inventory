CREATE TABLE commercial_ai_spending_limits (
 account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,period_start timestamptz NOT NULL,
 account_cap_minor bigint NOT NULL CHECK(account_cap_minor>0),
 changed_by_user_id text NOT NULL REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,period_start)
);
CREATE TABLE commercial_ai_workspace_spending_limits (
 account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 period_start timestamptz NOT NULL,workspace_cap_minor bigint NOT NULL CHECK(workspace_cap_minor>0),
 changed_by_user_id text NOT NULL REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,workspace_id,period_start)
);
CREATE TABLE commercial_ai_limit_changes (
 id text PRIMARY KEY,account_id text NOT NULL REFERENCES accounts(id),workspace_id text NOT NULL REFERENCES workspaces(id),
 actor_user_id text NOT NULL REFERENCES users(id),period_start timestamptz NOT NULL,detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE customers ADD COLUMN shipping_address_fields jsonb;
ALTER TABLE customers ADD COLUMN tax_exempt integer NOT NULL DEFAULT 0 CHECK(tax_exempt IN (0,1));
ALTER TABLE customers ADD COLUMN tax_exempt_reference text;
