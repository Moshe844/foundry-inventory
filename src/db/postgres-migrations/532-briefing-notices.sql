CREATE TABLE workspace_briefing_preferences (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id),
 show_in_needs boolean NOT NULL DEFAULT true,
 updated_by text NOT NULL REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now()
);
