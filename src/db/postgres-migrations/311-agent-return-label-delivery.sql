-- Keep queued return-label mail out of older generic provider workers.
CREATE FUNCTION stockchief_runtime.require_return_label_mail_worker() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE authority text;
BEGIN
 IF NEW.payload->>'effectId' IS NOT NULL THEN
  SELECT e.payload->'standingAuthority'->>'kind' INTO authority FROM stockchief_runtime.provider_effects e
   WHERE e.workspace_id=NEW.workspace_id AND e.id=NEW.payload->>'effectId' AND e.kind='mail.outbound.send';
  IF authority='return_label' AND NEW.kind<>'agent.mail.return_label.v1' THEN
   RAISE EXCEPTION 'Return-label delivery needs a compatible mail worker.' USING ERRCODE='23514',CONSTRAINT='return_label_mail_worker';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER return_label_mail_worker_protocol BEFORE INSERT OR UPDATE OF kind,payload ON stockchief_runtime.jobs
 FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.require_return_label_mail_worker();

CREATE INDEX provider_return_label_source ON stockchief_runtime.provider_effects(workspace_id,(payload->'standingAuthority'->>'shipmentId'))
 WHERE kind='mail.outbound.send' AND payload->'standingAuthority'->>'kind'='return_label';

ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details','po-delivery-date','container-plan','team-procedure','product-retirement','shutdown-purchase','promotion-purchase','delivery-qc','supplier-rfq','supplier-claim','customer-reservation','customer-priority','channel-buffer','annual-stocktake','partial-shipment','return-label'));
