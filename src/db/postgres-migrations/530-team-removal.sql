ALTER TABLE users ADD COLUMN revoked_at TIMESTAMPTZ;
CREATE INDEX users_active_membership ON users(workspace_id,account_id) WHERE revoked_at IS NULL;
