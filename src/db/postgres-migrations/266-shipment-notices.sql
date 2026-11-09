ALTER TABLE customer_communication_policy ADD COLUMN shipping_authorized_by text REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE customer_communication_policy ADD COLUMN shipping_mailbox_account text;

CREATE FUNCTION stockchief_prepare_shipping_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.handover IS DISTINCT FROM 'CARRIER' OR NEW.shipped_at IS NULL OR NEW.tracking_number IS NULL
     OR NEW.status NOT IN ('SHIPPED','DELIVERED') OR NEW.customer_return_id IS NOT NULL OR NEW.return_outbound_shipment_id IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.shipped_at IS NOT NULL AND OLD.handover='CARRIER' AND OLD.tracking_number IS NOT NULL
       AND OLD.status IN ('SHIPPED','DELIVERED') THEN RETURN NEW; END IF;
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
CREATE TRIGGER agent_shipment_notice AFTER INSERT OR UPDATE OF status,handover,tracking_number,shipped_at ON sales_shipments
  FOR EACH ROW EXECUTE FUNCTION stockchief_prepare_shipping_notice();
