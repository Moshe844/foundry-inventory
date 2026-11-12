-- Job 60: who tells a sales channel's customers that their order shipped.
-- Without a row, the channel tells them (marketplaces and online stores send
-- their own shipping emails), so StockChief never sends a second one.
CREATE TABLE stockchief_runtime.agent_shipping_notice_channels (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  sender text NOT NULL CHECK (sender IN ('channel','stockchief')),
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,connector_id)
);
CREATE INDEX agent_shipping_notice_channel_person ON stockchief_runtime.agent_shipping_notice_channels(updated_by) WHERE updated_by IS NOT NULL;

-- The tracking email is prepared once the parcel has physically left: a
-- person records the carrier handoff, or the carrier scans a label bought
-- here as moving, whichever comes first. The job key keeps it to one email.
CREATE OR REPLACE FUNCTION stockchief_prepare_shipping_notice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE handed boolean; was boolean;
BEGIN
  IF NEW.handover IS DISTINCT FROM 'CARRIER' OR NEW.tracking_number IS NULL
     OR NEW.customer_return_id IS NOT NULL OR NEW.return_outbound_shipment_id IS NOT NULL THEN RETURN NEW; END IF;
  handed:=COALESCE((NEW.shipped_at IS NOT NULL AND NEW.status IN ('SHIPPED','DELIVERED'))
    OR (NEW.status='PACKED' AND NEW.label_status='PURCHASED' AND NEW.tracking_status IN ('IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED')),false);
  IF NOT handed THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    was:=COALESCE(OLD.handover='CARRIER' AND OLD.tracking_number IS NOT NULL AND (
      (OLD.shipped_at IS NOT NULL AND OLD.status IN ('SHIPPED','DELIVERED'))
      OR (OLD.status='PACKED' AND OLD.label_status='PURCHASED' AND OLD.tracking_status IN ('IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED'))),false);
    IF was THEN RETURN NEW; END IF;
  END IF;
  WITH saved AS (INSERT INTO stockchief_runtime.jobs(id,workspace_id,kind,payload,priority,max_attempts,available_at,idempotency_key,created_at,updated_at)
    SELECT gen_random_uuid()::text,NEW.workspace_id,'agent.shipment-notice',jsonb_build_object('shipmentId',NEW.id),40,8,
      floor(extract(epoch from clock_timestamp())*1000)::bigint,'shipment:'||NEW.id,now(),now()
    FROM workspaces w JOIN account_subscriptions s ON s.account_id=w.owner_account_id
    JOIN commercial_plan_versions v ON v.id=s.plan_version_id AND v.plan_id=s.plan_id
    WHERE w.id=NEW.workspace_id AND (v.configuration->>'offerId'='agent-v3' OR s.plan_id='enterprise')
    AND NOT EXISTS(SELECT 1 FROM customer_communication_policy p WHERE p.workspace_id=w.id AND p.shipping_notice='off')
    ON CONFLICT DO NOTHING RETURNING id,available_at)
  INSERT INTO stockchief_runtime.job_events(id,job_id,event_type,detail,created_at)
    SELECT gen_random_uuid()::text,id,'ENQUEUED',jsonb_build_object('availableAt',available_at),now() FROM saved;
  RETURN NEW;
END $$;
DROP TRIGGER agent_shipment_notice ON sales_shipments;
CREATE TRIGGER agent_shipment_notice AFTER INSERT OR UPDATE OF status,handover,tracking_number,shipped_at,tracking_status,label_status ON sales_shipments
  FOR EACH ROW EXECUTE FUNCTION stockchief_prepare_shipping_notice();
