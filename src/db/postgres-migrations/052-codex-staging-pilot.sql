-- Staging-only admission and a shared, PostgreSQL-backed pilot spending ledger.
-- Creating these tables does not enable an agent or approve any spending.
CREATE TABLE stockchief_runtime.codex_pilots (
 workspace_id TEXT PRIMARY KEY REFERENCES public.workspaces(id),
 enabled BOOLEAN NOT NULL DEFAULT false,
 authorized_actor_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
 approved_by TEXT NOT NULL REFERENCES public.users(id),
 period_ends_at TIMESTAMPTZ NOT NULL,
 ceiling_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK(ceiling_micro_usd>=0),
 approval_reference TEXT,
 stopped BOOLEAN NOT NULL DEFAULT true,
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE stockchief_runtime.codex_pilot_calls (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES stockchief_runtime.codex_pilots(workspace_id),
 actor_id TEXT NOT NULL REFERENCES public.users(id),
 goal_id TEXT NOT NULL REFERENCES stockchief_runtime.assistant_goals(id),
 reserved BIGINT NOT NULL CHECK(reserved>0 AND reserved<=300000),
 charged BIGINT CHECK(charged>=0 AND charged<=reserved),
 state TEXT NOT NULL CHECK(state IN ('RESERVED','UNKNOWN','SETTLED')),
 detail JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX codex_pilot_calls_scope ON stockchief_runtime.codex_pilot_calls(workspace_id,state);
