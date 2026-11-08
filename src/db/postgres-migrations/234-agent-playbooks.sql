CREATE TABLE stockchief_runtime.agent_playbooks (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 created_by text NOT NULL REFERENCES users(id), name text NOT NULL, steps jsonb NOT NULL,
 cadence text NOT NULL CHECK(cadence IN ('manual','daily','weekly')),
 next_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_playbooks_due ON stockchief_runtime.agent_playbooks(next_at) WHERE next_at IS NOT NULL;
CREATE TABLE stockchief_runtime.agent_playbook_runs (
 id text PRIMARY KEY,playbook_id text NOT NULL REFERENCES stockchief_runtime.agent_playbooks(id) ON DELETE CASCADE,
 request_key text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(playbook_id,request_key)
);
