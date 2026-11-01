CREATE TABLE account_mfa (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 secret JSONB,
 pending_secret JSONB,
 pending_expires_at TIMESTAMPTZ,
 enabled BOOLEAN NOT NULL DEFAULT false,
 revision INTEGER NOT NULL DEFAULT 0,
 last_counter BIGINT NOT NULL DEFAULT -1,
 recovery_hashes JSONB NOT NULL DEFAULT '[]',
 failed_count INTEGER NOT NULL DEFAULT 0,
 window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 blocked_until TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE workspace_security_policies (
 workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 require_mfa BOOLEAN NOT NULL DEFAULT false,
 updated_by_user_id TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE security_event_history (
 id TEXT PRIMARY KEY,
 workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
 account_id TEXT,
 actor_id TEXT,
 action TEXT NOT NULL,
 reference TEXT,
 before_state JSONB NOT NULL DEFAULT '{}',
 after_state JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX security_event_history_inventory_time ON security_event_history(workspace_id,created_at DESC,id);
CREATE TRIGGER security_event_history_immutable BEFORE UPDATE OR DELETE ON security_event_history FOR EACH ROW EXECUTE FUNCTION protect_catalogue_change_history();
