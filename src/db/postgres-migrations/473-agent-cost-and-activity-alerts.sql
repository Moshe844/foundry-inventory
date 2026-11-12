-- Jobs 170 and 171: cost and margin alerts, and unusual activity.
--
-- Both keep their owner settings in agent_alert_settings. Job 170 adds the
-- cost rise the owner wants to hear about; job 171 adds how many changes by
-- one person in a day, and how big a selling price change, count as unusual.
ALTER TABLE stockchief_runtime.agent_alert_settings
  ADD COLUMN cost_rise_pct numeric(7,2) CHECK (cost_rise_pct IS NULL OR (job_id=170 AND cost_rise_pct>0 AND cost_rise_pct<=1000)),
  ADD COLUMN edit_count integer CHECK (edit_count IS NULL OR (job_id=171 AND edit_count BETWEEN 1 AND 100000)),
  ADD COLUMN price_change_pct numeric(7,2) CHECK (price_change_pct IS NULL OR (job_id=171 AND price_change_pct>0 AND price_change_pct<=1000));

-- Both alerts reach email through the shared alert delivery (jobs 166 to 168).
ALTER TABLE stockchief_runtime.agent_alert_channels
  DROP CONSTRAINT agent_alert_channels_job_id_check,
  ADD CONSTRAINT agent_alert_channels_job_id_check CHECK (job_id IN (166,167,168,170,171));
ALTER TABLE stockchief_runtime.agent_alert_deliveries
  DROP CONSTRAINT agent_alert_deliveries_job_id_check,
  ADD CONSTRAINT agent_alert_deliveries_job_id_check CHECK (job_id IN (166,167,168,170,171));

-- Deleting a customer, supplier or product is now recorded with who did it,
-- so unusual activity can count deletions by one person.
CREATE INDEX security_event_history_deletions ON security_event_history(workspace_id,created_at)
  WHERE action='Record deleted';
