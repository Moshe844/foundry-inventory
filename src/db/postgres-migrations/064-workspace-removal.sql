CREATE TABLE stockchief_runtime.workspace_removals (
 workspace_id TEXT PRIMARY KEY REFERENCES public.workspaces(id),
 requested_by_account_id TEXT NOT NULL REFERENCES public.accounts(id),
 requested_by_actor_id TEXT NOT NULL REFERENCES public.users(id),
 summary JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
