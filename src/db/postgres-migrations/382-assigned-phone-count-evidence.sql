ALTER TABLE stockchief_runtime.agent_count_tasks
  ADD COLUMN scheduled boolean NOT NULL DEFAULT false,
  ADD COLUMN includes_tracking boolean NOT NULL DEFAULT false;
UPDATE stockchief_runtime.agent_count_tasks SET scheduled=true WHERE request_key LIKE 'schedule:%';

ALTER TABLE stockchief_runtime.agent_count_schedules
  ADD COLUMN includes_tracking boolean NOT NULL DEFAULT false,
  ADD COLUMN example_campaign_id text REFERENCES warehouse_count_campaigns(id) ON DELETE SET NULL;

CREATE INDEX agent_count_teaching_history ON stockchief_runtime.agent_count_tasks
  (workspace_id, location_id, counter_id, includes_tracking, campaign_id) WHERE scheduled=false;

CREATE TABLE stockchief_runtime.agent_count_position_evidence (
  workspace_id text NOT NULL,
  campaign_id text NOT NULL,
  location_id text NOT NULL,
  sku_id text NOT NULL,
  before_count jsonb NOT NULL,
  observation jsonb,
  reviewed_at timestamptz,
  PRIMARY KEY (campaign_id, location_id, sku_id),
  FOREIGN KEY (workspace_id, campaign_id) REFERENCES warehouse_count_campaigns(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (campaign_id, location_id, sku_id) REFERENCES warehouse_count_campaign_lines(campaign_id, location_id, sku_id) ON DELETE CASCADE
);
CREATE INDEX agent_count_position_serial_check ON stockchief_runtime.agent_count_position_evidence(campaign_id, sku_id)
  WHERE observation IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression)
VALUES('stockchief_runtime.agent_count_position_evidence'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
SELECT id,'stockchief_runtime.agent_count_position_evidence'::regclass,true FROM workspaces;

CREATE FUNCTION stockchief_reject_legacy_phone_count_worker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='warehouse.count.apply' AND EXISTS (
    SELECT 1 FROM stockchief_runtime.agent_count_position_evidence e
    WHERE e.workspace_id=NEW.workspace_id AND e.campaign_id=NEW.payload->>'campaignId'
  ) THEN
    RAISE EXCEPTION 'This worksheet requires the phone-count worker for identity and measure verification.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stockchief_require_phone_count_worker
BEFORE INSERT ON stockchief_runtime.jobs FOR EACH ROW EXECUTE FUNCTION stockchief_reject_legacy_phone_count_worker();
