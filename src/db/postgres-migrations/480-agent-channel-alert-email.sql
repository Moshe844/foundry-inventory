-- Job 169: sales channel problems (oversell risk, a stopped or failed sync)
-- reach the owner by email the same way as jobs 166 to 168. The alerts are
-- already agent notices; these two tables now accept them too. Job 169 joins
-- whatever job list each table allows by now, so jobs added by other
-- migrations stay allowed.
DO $$
DECLARE target record; allowed text;
BEGIN
 FOR target IN SELECT * FROM (VALUES
  ('stockchief_runtime.agent_alert_channels','agent_alert_channels_job_id_check'),
  ('stockchief_runtime.agent_alert_deliveries','agent_alert_deliveries_job_id_check')) t(relation,name) LOOP
  SELECT pg_get_constraintdef(oid) INTO allowed FROM pg_constraint WHERE conname=target.name AND conrelid=target.relation::regclass;
  IF allowed IS NULL OR position('ARRAY[' IN allowed)=0 THEN
   RAISE EXCEPTION 'The job list on % has an unexpected form.',target.relation;
  END IF;
  IF allowed !~ '\m169\M' THEN
   EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I ',target.relation,target.name,target.name)||replace(allowed,'ARRAY[','ARRAY[169, ');
  END IF;
 END LOOP;
END $$;
