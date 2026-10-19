-- Account rollout grants reuse an existing approved funding source. No grant,
-- budget approval, expiry extension or customer rollout is created here.
CREATE TABLE stockchief_runtime.codex_pilot_accounts (
 account_id TEXT PRIMARY KEY REFERENCES public.accounts(id),
 funding_workspace_id TEXT NOT NULL UNIQUE REFERENCES stockchief_runtime.codex_pilots(workspace_id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE stockchief_runtime.codex_pilot_workspace_settings (
 workspace_id TEXT PRIMARY KEY REFERENCES public.workspaces(id),
 enabled BOOLEAN NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE stockchief_runtime.codex_pilot_calls ADD COLUMN funding_workspace_id TEXT REFERENCES stockchief_runtime.codex_pilots(workspace_id);
UPDATE stockchief_runtime.codex_pilot_calls SET funding_workspace_id=workspace_id;
ALTER TABLE stockchief_runtime.codex_pilot_calls ALTER COLUMN funding_workspace_id SET NOT NULL;
ALTER TABLE stockchief_runtime.codex_pilot_calls DROP CONSTRAINT codex_pilot_calls_workspace_id_fkey;
ALTER TABLE stockchief_runtime.codex_pilot_calls ADD FOREIGN KEY(workspace_id) REFERENCES public.workspaces(id);
CREATE INDEX codex_pilot_calls_funding ON stockchief_runtime.codex_pilot_calls(funding_workspace_id,state);

CREATE VIEW stockchief_runtime.codex_pilot_workspace_access WITH(security_invoker=true) AS
SELECT w.id AS workspace_id,w.owner_account_id,p.workspace_id AS funding_workspace_id,
 (a.account_id IS NOT NULL) AS account_inherited,
 p.worker_seen_at,
 to_jsonb(p)||jsonb_build_object('workspace_id',w.id,'funding_workspace_id',p.workspace_id,
  'enabled',p.enabled AND COALESCE(s.enabled,true),
  'revision',p.revision+COALESCE(s.revision,0),'account_inherited',a.account_id IS NOT NULL) AS pilot
FROM public.workspaces w
LEFT JOIN stockchief_runtime.codex_pilot_accounts a ON a.account_id=w.owner_account_id
JOIN stockchief_runtime.codex_pilots p ON p.workspace_id=COALESCE(a.funding_workspace_id,w.id)
JOIN public.workspaces funding ON funding.id=p.workspace_id
LEFT JOIN stockchief_runtime.codex_pilot_workspace_settings s ON s.workspace_id=w.id
WHERE w.deletion_requested_at IS NULL AND funding.deletion_requested_at IS NULL
 AND (a.account_id IS NULL OR funding.owner_account_id=a.account_id);

-- Old workers can still settle existing receipts during a rolling cutover.
-- New reservations bind permanently to the single current funding source.
CREATE FUNCTION stockchief_runtime.codex_bind_call_funding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected TEXT;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.funding_workspace_id<>OLD.funding_workspace_id OR NEW.workspace_id<>OLD.workspace_id THEN
   RAISE EXCEPTION 'Codex receipt scope is immutable';
  END IF;
  RETURN NEW;
 END IF;
 SELECT funding_workspace_id INTO expected FROM stockchief_runtime.codex_pilot_workspace_access WHERE workspace_id=NEW.workspace_id;
 IF expected IS NULL OR (NEW.funding_workspace_id IS NOT NULL AND NEW.funding_workspace_id<>expected) THEN
  RAISE EXCEPTION 'Codex funding scope does not match business ownership';
 END IF;
 NEW.funding_workspace_id=expected;
 RETURN NEW;
END $$;
CREATE TRIGGER codex_bind_call_funding BEFORE INSERT OR UPDATE ON stockchief_runtime.codex_pilot_calls
 FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.codex_bind_call_funding();
