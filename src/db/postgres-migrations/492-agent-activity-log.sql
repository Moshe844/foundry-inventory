-- Job 181: every action StockChief completes from a prepared change writes
-- one 'Agent action completed' entry to the audit trail, with the job, the
-- rule or approval that allowed it and its evidence. The activity log finds
-- those entries by the change they belong to.
CREATE INDEX security_event_history_agent_completed ON security_event_history(workspace_id,reference)
 WHERE action='Agent action completed';

-- Job 204: the daily "what I did" digest, kept per business day. It shows in
-- the app and Needs you as an agent notice, and reaches email through the
-- shared alert delivery, so job 204 joins whatever job lists those tables
-- allow by now.
CREATE TABLE stockchief_runtime.agent_work_digests (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 report_date date NOT NULL,
 summary jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,report_date)
);
CREATE INDEX agent_work_digest_latest ON stockchief_runtime.agent_work_digests(workspace_id,report_date DESC);
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
  IF allowed !~ '\m204\M' THEN
   EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I ',target.relation,target.name,target.name)||replace(allowed,'ARRAY[','ARRAY[204, ');
  END IF;
 END LOOP;
END $$;
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_work_digests'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_work_digests'::regclass,true FROM workspaces;
