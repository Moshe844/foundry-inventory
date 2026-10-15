-- A notification is a wake-up hint, never approval or execution authority.
-- PostgreSQL publishes it only after the canonical state transaction commits.
-- Existing durable dependency sweeps remain the recovery path after disconnects.
CREATE FUNCTION stockchief_runtime.notify_goal_dependency_change()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_notify('stockchief_codex_jobs',
    jsonb_build_object('kind','dependency_changed','workspaceId',NEW.workspace_id)::text);
  RETURN NEW;
END;
$$;

CREATE TRIGGER stockchief_provider_dependency_changed
AFTER UPDATE OF status ON stockchief_runtime.provider_effects
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status
  AND NEW.status IN ('SUCCEEDED','FAILED','AMBIGUOUS','CANCELLED'))
EXECUTE FUNCTION stockchief_runtime.notify_goal_dependency_change();

CREATE TRIGGER stockchief_mission_dependency_changed
AFTER UPDATE OF status ON stockchief_runtime.assistant_capability_plans
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status
  AND NEW.status IN ('DONE','BLOCKED','CANCELLED','WAITING'))
EXECUTE FUNCTION stockchief_runtime.notify_goal_dependency_change();
