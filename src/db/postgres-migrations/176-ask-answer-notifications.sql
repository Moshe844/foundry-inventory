-- Notifications carry identifiers only. Every subscriber rechecks its own
-- session, actor and inventory before reading an answer from PostgreSQL.
CREATE FUNCTION stockchief_runtime.notify_ask_answer()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_notify('stockchief_ask_answers',jsonb_build_object(
  'goal',NEW.id,'workspace',NEW.workspace_id,'actor',NEW.actor_user_id)::text);
 RETURN NEW;
END;
$$;
CREATE TRIGGER stockchief_ask_answer_changed
AFTER UPDATE OF answer,status ON stockchief_runtime.assistant_goals
FOR EACH ROW WHEN (OLD.answer IS DISTINCT FROM NEW.answer OR OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION stockchief_runtime.notify_ask_answer();
