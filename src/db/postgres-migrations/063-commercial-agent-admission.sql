-- Commercial enrollment is automatic only behind the deployment rollout flag.
-- It never changes an explicitly approved pilot or its shared funding ceiling.
ALTER TABLE stockchief_runtime.codex_pilots ADD COLUMN admission_kind TEXT NOT NULL DEFAULT 'PILOT'
 CHECK(admission_kind IN ('PILOT','COMMERCIAL'));
ALTER TABLE stockchief_runtime.codex_pilots ADD COLUMN period_starts_at TIMESTAMPTZ;
-- Removing an operational inventory does not erase its account's cost ledger.
-- The funding workspace remains an audit container, not an execution grant.
CREATE OR REPLACE VIEW stockchief_runtime.codex_pilot_workspace_access WITH(security_invoker=true) AS
SELECT w.id AS workspace_id,w.owner_account_id,p.workspace_id AS funding_workspace_id,
 (a.account_id IS NOT NULL) AS account_inherited,p.worker_seen_at,
 to_jsonb(p)||jsonb_build_object('workspace_id',w.id,'funding_workspace_id',p.workspace_id,
  'enabled',p.enabled AND COALESCE(s.enabled,true),
  'revision',p.revision+COALESCE(s.revision,0),'account_inherited',a.account_id IS NOT NULL) AS pilot
FROM public.workspaces w
LEFT JOIN stockchief_runtime.codex_pilot_accounts a ON a.account_id=w.owner_account_id
JOIN stockchief_runtime.codex_pilots p ON p.workspace_id=COALESCE(a.funding_workspace_id,w.id)
JOIN public.workspaces funding ON funding.id=p.workspace_id
LEFT JOIN stockchief_runtime.codex_pilot_workspace_settings s ON s.workspace_id=w.id
WHERE w.deletion_requested_at IS NULL
 AND (a.account_id IS NULL OR funding.owner_account_id=a.account_id);
