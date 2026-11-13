-- Job 201: the circuit breaker compares every automatic action StockChief
-- takes with its usual day, not only purchases, transfers and labels. Each
-- automatic action it takes elsewhere (a prepared change a routine carries
-- out, an email it sends on its own, a price or cost it changes, a delivery
-- cost it posts) is recorded once here, with its money when it has any.
CREATE TABLE stockchief_runtime.agent_automatic_actions (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 action_key text NOT NULL CHECK (length(action_key) BETWEEN 1 AND 300),
 kind text NOT NULL CHECK (kind IN ('purchase','transfer','label','email','credit','landed_cost','price','stock','sale','change')),
 reference text CHECK (length(reference)<=300),
 at timestamptz NOT NULL DEFAULT clock_timestamp(),
 currency text CHECK (currency ~ '^[A-Z]{3}$'),
 amount_minor bigint CHECK (amount_minor>=0),
 CHECK ((currency IS NULL)=(amount_minor IS NULL)),
 PRIMARY KEY (workspace_id,action_key)
);
CREATE INDEX agent_automatic_actions_time ON stockchief_runtime.agent_automatic_actions(workspace_id,at);
-- A pause tells the owner at once: in Needs you and by the alert email the
-- owner chose. Job 201 joins whatever job list each table allows by now.
DO $$
DECLARE target record; allowed text;
BEGIN
 FOR target IN SELECT * FROM (VALUES
  ('stockchief_runtime.agent_operational_notices','agent_operational_notices_job_id_check'),
  ('stockchief_runtime.agent_alert_channels','agent_alert_channels_job_id_check'),
  ('stockchief_runtime.agent_alert_deliveries','agent_alert_deliveries_job_id_check')) t(relation,name) LOOP
  SELECT pg_get_constraintdef(oid) INTO allowed FROM pg_constraint WHERE conname=target.name AND conrelid=target.relation::regclass;
  IF allowed IS NULL OR position('ARRAY[' IN allowed)=0 THEN
   RAISE EXCEPTION 'The job list on % has an unexpected form.',target.relation;
  END IF;
  IF allowed !~ '\m201\M' THEN
   EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I ',target.relation,target.name,target.name)||replace(allowed,'ARRAY[','ARRAY[201, ');
  END IF;
 END LOOP;
END $$;
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_automatic_actions'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_automatic_actions'::regclass,true FROM workspaces;
