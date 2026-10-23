CREATE TABLE stockchief_runtime.inspection_role_scopes (
 role_name TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
 account_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('read','metrics')),
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON stockchief_runtime.inspection_role_scopes FROM PUBLIC;
CREATE FUNCTION stockchief_runtime.inspection_scope() RETURNS JSONB
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT pg_catalog.jsonb_build_object('workspaceId',s.workspace_id,'accountId',s.account_id,'kind',s.kind)
 FROM stockchief_runtime.inspection_role_scopes s
 WHERE s.role_name=SESSION_USER AND s.expires_at>pg_catalog.statement_timestamp()
$$;
COMMENT ON FUNCTION stockchief_runtime.inspection_scope() IS
 'Host-provisioned inspection scope for the immutable SQL login identity. Accepts no caller-supplied tenant or settings.';
GRANT EXECUTE ON FUNCTION stockchief_runtime.inspection_scope() TO PUBLIC;
