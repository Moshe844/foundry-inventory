ALTER TABLE workspaces ADD COLUMN time_zone_confirmed_at TIMESTAMPTZ;
CREATE TABLE workspace_record_aliases (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('location','sku','customer','supplier','item')),
 alias_key TEXT NOT NULL,
 alias TEXT NOT NULL,
 target_id TEXT NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_by TEXT NOT NULL REFERENCES users(id),
 PRIMARY KEY(workspace_id,kind,alias_key)
);
-- Repair the old inherited UTC default only where the owner has supplied a
-- different time zone and no executed Ask preference explicitly selected UTC.
UPDATE workspaces w SET time_zone=a.time_zone FROM accounts a
 WHERE a.id=w.owner_account_id AND w.time_zone='UTC' AND a.time_zone<>'UTC'
 AND w.deletion_requested_at IS NULL AND NOT EXISTS (
 SELECT 1 FROM stockchief_runtime.assistant_action_proposals p WHERE p.workspace_id=w.id
 AND p.action_type='settings.ask_preferences' AND p.status='EXECUTED' AND p.payload->>'timeZone'='UTC');
