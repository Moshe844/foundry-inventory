CREATE TABLE stockchief_runtime.agent_alert_settings (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id smallint NOT NULL CHECK(job_id IN (170,171)),
  margin_pct numeric(5,2) CHECK(margin_pct BETWEEN 0 AND 100),
  adjustment_units numeric(24,6) CHECK(adjustment_units>0),
  night_from integer CHECK(night_from BETWEEN 0 AND 23),
  night_until integer CHECK(night_until BETWEEN 0 AND 23),
  revision integer NOT NULL CHECK(revision>0),
  PRIMARY KEY(workspace_id,job_id),
  CHECK((night_from IS NULL)=(night_until IS NULL) AND night_from IS DISTINCT FROM night_until OR night_from IS NULL AND night_until IS NULL)
);
ALTER TABLE stockchief_runtime.agent_operational_notices DROP CONSTRAINT agent_operational_notices_job_id_check;
ALTER TABLE stockchief_runtime.agent_operational_notices ADD CHECK(job_id IN (124,167,168,169,170,171));
INSERT INTO commercial_storage_tables(relation,bytes_expression)
  VALUES('stockchief_runtime.agent_alert_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.agent_alert_settings'::regclass,true FROM workspaces;
