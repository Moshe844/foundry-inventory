-- Job 178: procedures are also written for picking and for customer returns,
-- the owner can edit the staff text, and on Pro and Custom StockChief can
-- publish its updates to staff on its own.
ALTER TABLE stockchief_runtime.agent_team_procedure_sets DROP CONSTRAINT agent_team_procedure_sets_kind_check;
ALTER TABLE stockchief_runtime.agent_team_procedure_sets
 ADD CONSTRAINT agent_team_procedure_sets_kind_check CHECK(kind IN ('receiving','picking','dispatch','counting','returns')),
 ADD COLUMN auto_publish boolean NOT NULL DEFAULT false;
ALTER TABLE stockchief_runtime.agent_team_procedure_publications
 ADD COLUMN automatic boolean NOT NULL DEFAULT false,
 ADD COLUMN edited boolean NOT NULL DEFAULT false;
CREATE INDEX agent_procedure_return_history ON customer_returns(workspace_id,received_at DESC,id DESC) WHERE received_at IS NOT NULL;
CREATE INDEX agent_procedure_wave_history ON fulfillment_waves(workspace_id,created_at DESC,id DESC) WHERE status IN ('PICKING','PACKED','COMPLETED','BLOCKED');

-- Job 180: the daily team summary, kept per business day. It shows in the app
-- and Needs you as an agent notice, and reaches email through the shared alert
-- delivery, so job 180 joins whatever job lists those tables allow by now.
CREATE TABLE stockchief_runtime.agent_team_summaries (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 report_date date NOT NULL,
 summary jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,report_date)
);
CREATE INDEX agent_team_summary_latest ON stockchief_runtime.agent_team_summaries(workspace_id,report_date DESC);
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
  IF allowed !~ '\m180\M' THEN
   EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I ',target.relation,target.name,target.name)||replace(allowed,'ARRAY[','ARRAY[180, ');
  END IF;
 END LOOP;
END $$;
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_team_summaries'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_team_summaries'::regclass,true FROM workspaces;
