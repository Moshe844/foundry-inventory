CREATE TABLE workspace_custom_roles (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 permissions TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id)
);
CREATE UNIQUE INDEX workspace_custom_role_name ON workspace_custom_roles(workspace_id,lower(name));
ALTER TABLE users ADD COLUMN custom_role_id TEXT;
ALTER TABLE users ADD CONSTRAINT users_custom_role_scope FOREIGN KEY(workspace_id,custom_role_id) REFERENCES workspace_custom_roles(workspace_id,id);
ALTER TABLE users ADD COLUMN po_approval_limit_minor BIGINT CHECK(po_approval_limit_minor BETWEEN 0 AND 9007199254740991);
ALTER TABLE users ADD COLUMN po_approval_currency TEXT CHECK(po_approval_currency ~ '^[A-Z]{3}$');
ALTER TABLE users ADD CONSTRAINT users_po_limit_currency CHECK((po_approval_limit_minor IS NULL)=(po_approval_currency IS NULL));
ALTER TABLE users ADD COLUMN access_revision INTEGER NOT NULL DEFAULT 1;
CREATE TABLE team_access_history (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL,
 subject_id TEXT NOT NULL,
 action TEXT NOT NULL,
 before_state JSONB NOT NULL,
 after_state JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX team_access_history_time ON team_access_history(workspace_id,created_at DESC,id);
CREATE TRIGGER team_access_history_immutable BEFORE UPDATE OR DELETE ON team_access_history FOR EACH ROW EXECUTE FUNCTION protect_catalogue_change_history();
