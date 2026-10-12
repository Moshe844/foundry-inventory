-- Reasoning checkpoints only. Business effects remain in canonical engines and missions.
CREATE TABLE stockchief_runtime.assistant_goals (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
 actor_user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 request_key TEXT NOT NULL,
 original_request TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'READY' CHECK (status IN
  ('READY','RUNNING','WAITING_APPROVAL','WAITING_EVENT','WAITING_USER','COMPLETED','BLOCKED','CANCELLED')),
 checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
 answer TEXT NOT NULL DEFAULT '',
 turns INTEGER NOT NULL DEFAULT 0 CHECK (turns >= 0),
 tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
 recoveries INTEGER NOT NULL DEFAULT 0 CHECK (recoveries >= 0),
 budget_minor NUMERIC NOT NULL CHECK (budget_minor > 0 AND budget_minor <= 100),
 run_token TEXT,
 lease_until TIMESTAMPTZ,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '7 days',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,actor_user_id,request_key)
);
CREATE INDEX assistant_goals_resume ON stockchief_runtime.assistant_goals(status,updated_at);
CREATE TABLE stockchief_runtime.assistant_goal_events (
 id TEXT PRIMARY KEY,
 goal_id TEXT NOT NULL REFERENCES stockchief_runtime.assistant_goals(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL,
 kind TEXT NOT NULL,
 detail JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(goal_id,sequence)
);
ALTER TABLE commercial_model_cost_holds ADD COLUMN goal_id TEXT
 REFERENCES stockchief_runtime.assistant_goals(id) ON DELETE RESTRICT;
CREATE INDEX commercial_model_cost_holds_goal ON commercial_model_cost_holds(goal_id) WHERE goal_id IS NOT NULL;
ALTER TABLE stockchief_runtime.assistant_capability_plans ADD COLUMN goal_id TEXT
 REFERENCES stockchief_runtime.assistant_goals(id) ON DELETE RESTRICT;
