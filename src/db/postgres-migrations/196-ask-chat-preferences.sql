-- What a person did with their own conversations: its name, whether it is pinned,
-- and whether they deleted it. The questions and answers stay for the audit trail.
CREATE TABLE stockchief_runtime.assistant_chat_preferences (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 actor_user_id TEXT NOT NULL,
 chat_id TEXT NOT NULL,
 title TEXT,
 pinned_at TIMESTAMPTZ,
 deleted_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (workspace_id,actor_user_id,chat_id)
);
