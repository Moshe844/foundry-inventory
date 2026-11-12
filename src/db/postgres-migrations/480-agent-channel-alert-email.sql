-- Job 169: sales channel problems (oversell risk, a stopped or failed sync)
-- reach the owner by email the same way as jobs 166 to 168. The alerts are
-- already agent notices; these two tables now accept them too.
ALTER TABLE stockchief_runtime.agent_alert_channels DROP CONSTRAINT agent_alert_channels_job_id_check,
  ADD CONSTRAINT agent_alert_channels_job_id_check CHECK (job_id IN (166,167,168,169));
ALTER TABLE stockchief_runtime.agent_alert_deliveries DROP CONSTRAINT agent_alert_deliveries_job_id_check,
  ADD CONSTRAINT agent_alert_deliveries_job_id_check CHECK (job_id IN (166,167,168,169));
