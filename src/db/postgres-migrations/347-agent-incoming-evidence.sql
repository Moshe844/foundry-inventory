ALTER TABLE purchase_order_lines
  ADD COLUMN supplier_supply_hold_id text,
  ADD COLUMN supplier_supply_hold_at timestamptz,
  ADD COLUMN supplier_amendment_parent_line_id text;
CREATE INDEX supplier_supply_hold_notice ON purchase_order_lines(workspace_id,supplier_supply_hold_id)
WHERE supplier_supply_hold_id IS NOT NULL;

-- These columns cache evidence already stored and metered in supplier notices.
-- Preserve the byte representation of existing and future business rows.
UPDATE commercial_storage_tables SET bytes_expression=replace(bytes_expression,'to_jsonb(t)',
  '(to_jsonb(t)-ARRAY[''supplier_supply_hold_id'',''supplier_supply_hold_at'',''supplier_amendment_parent_line_id'']::text[])')
WHERE relation='purchase_order_lines'::regclass;

CREATE FUNCTION stockchief_runtime.refresh_incoming_evidence(target_workspace text,target_line text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE item record; held record;
BEGIN
 SELECT l.id,l.sku_id,l.supplier_supply_hold_id,l.purchase_order_id,p.supplier_id,
   coalesce(l.destination_location_id,p.destination_location_id) AS location_id
 INTO item FROM purchase_order_lines l JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
 WHERE l.workspace_id=target_workspace AND l.id=target_line FOR UPDATE OF l;
 IF NOT FOUND THEN RETURN; END IF;
 WITH RECURSIVE lineage AS (
   SELECT l.id,l.supplier_amendment_parent_line_id FROM purchase_order_lines l
   WHERE l.workspace_id=target_workspace AND l.id=target_line
   UNION
   SELECT parent.id,parent.supplier_amendment_parent_line_id FROM purchase_order_lines parent
   JOIN lineage child ON child.supplier_amendment_parent_line_id=parent.id
   WHERE parent.workspace_id=target_workspace AND parent.purchase_order_id=item.purchase_order_id
 )
 SELECT n.id,n.reported_at INTO held
 FROM stockchief_runtime.agent_backup_supplier_notices n
 JOIN stockchief_runtime.supplier_link_submissions r ON r.workspace_id=n.workspace_id AND r.id=n.supplier_reply_id AND r.kind='unavailable'
 JOIN stockchief_runtime.supplier_order_links link ON link.workspace_id=r.workspace_id AND link.token_hash=r.token_hash
 WHERE n.workspace_id=target_workspace AND (n.line_id IN (SELECT id FROM lineage) OR n.id=item.supplier_supply_hold_id)
   AND n.purchase_order_id=item.purchase_order_id AND link.purchase_order_id=item.purchase_order_id
   AND n.sku_id=item.sku_id AND n.location_id=item.location_id AND n.supplier_id=item.supplier_id
   AND n.revoked_at IS NULL AND n.reported_at<=now() AND link.expires_at>r.created_at
   AND NOT EXISTS(
     SELECT 1 FROM stockchief_runtime.supplier_link_submissions accepted
     JOIN stockchief_runtime.supplier_order_links accepted_link
       ON accepted_link.workspace_id=accepted.workspace_id AND accepted_link.token_hash=accepted.token_hash
     JOIN purchase_orders po ON po.workspace_id=accepted_link.workspace_id AND po.id=accepted_link.purchase_order_id
     WHERE accepted.workspace_id=n.workspace_id AND po.id=n.purchase_order_id AND accepted.created_at>n.reported_at
       AND accepted_link.expires_at>accepted.created_at AND accepted.kind='confirm'
       AND (accepted.expected_date IS NULL OR accepted.expected_date=po.expected_date::date)
   )
   AND NOT EXISTS(
     SELECT 1 FROM supplier_documents d WHERE d.workspace_id=n.workspace_id AND d.purchase_order_id=n.purchase_order_id
       AND d.document_type='order_acknowledgement' AND d.status='MATCHED' AND d.processed_at::timestamptz>n.reported_at
       AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.facts::jsonb->'lines')='array'
         THEN d.facts::jsonb->'lines' ELSE '[]'::jsonb END) accepted_line WHERE accepted_line->>'lineId'=n.line_id)
   )
   AND NOT EXISTS(
     SELECT 1 FROM stockchief_runtime.agent_po_date_sources reviewed
     JOIN stockchief_runtime.supplier_link_submissions accepted
       ON accepted.workspace_id=reviewed.workspace_id AND accepted.id=reviewed.source_id
     WHERE reviewed.workspace_id=n.workspace_id AND reviewed.purchase_order_id=n.purchase_order_id
       AND reviewed.processed_at IS NOT NULL AND reviewed.instruction_hash IS NOT NULL
       AND accepted.kind='amendment' AND accepted.created_at>n.reported_at
       AND EXISTS(SELECT 1 FROM jsonb_array_elements(accepted.amendment->'changes') proposed(value)
         WHERE proposed.value ? 'quantity' AND (proposed.value->>'lineId' IN (n.line_id,item.id) OR
           EXISTS(SELECT 1 FROM jsonb_array_elements(reviewed.source_snapshot->'amendments') checked
             WHERE checked->>'lineId'=proposed.value->>'lineId' AND checked->>'supplyHold'=n.id)))
   )
 ORDER BY n.reported_at DESC,n.id DESC LIMIT 1;
 UPDATE purchase_order_lines SET supplier_supply_hold_id=held.id,supplier_supply_hold_at=held.reported_at
 WHERE workspace_id=target_workspace AND id=target_line
   AND (supplier_supply_hold_id IS DISTINCT FROM held.id OR supplier_supply_hold_at IS DISTINCT FROM held.reported_at);
 IF FOUND THEN
  PERFORM stockchief_expire_replenishment(jsonb_build_array(jsonb_build_object('workspace_id',target_workspace,'sku_id',item.sku_id)),
    'supplier_availability_changed');
  PERFORM stockchief_signal_reorder_candidates(jsonb_build_array(jsonb_build_object('workspace_id',target_workspace,
    'sku_id',item.sku_id,'location_id',item.location_id,
    'remaining',coalesce((SELECT on_hand FROM balances WHERE workspace_id=target_workspace AND sku_id=item.sku_id AND location_id=item.location_id),0))));
 END IF;
END $$;

CREATE FUNCTION stockchief_runtime.supplier_notice_incoming_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected record; source record;
BEGIN
 IF TG_OP='DELETE' THEN source:=OLD; ELSE source:=NEW; END IF;
 IF source.line_id IS NULL THEN
   IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 FOR affected IN SELECT id FROM purchase_order_lines
   WHERE workspace_id=source.workspace_id AND (id=source.line_id OR supplier_supply_hold_id=source.id) ORDER BY id
 LOOP PERFORM stockchief_runtime.refresh_incoming_evidence(source.workspace_id,affected.id); END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER supplier_notice_incoming_evidence
AFTER INSERT OR UPDATE OR DELETE ON stockchief_runtime.agent_backup_supplier_notices
FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.supplier_notice_incoming_evidence();

CREATE FUNCTION stockchief_runtime.inherit_supplier_incoming_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_hold record;
BEGIN
 SELECT id,supplier_supply_hold_id,supplier_supply_hold_at INTO current_hold FROM purchase_order_lines l
 WHERE l.workspace_id=NEW.workspace_id AND l.purchase_order_id=NEW.purchase_order_id AND l.sku_id=NEW.sku_id
   AND l.destination_location_id IS NOT DISTINCT FROM NEW.destination_location_id
   AND (NEW.supplier_amendment_parent_line_id IS NOT NULL AND l.id=NEW.supplier_amendment_parent_line_id OR
     NEW.supplier_amendment_parent_line_id IS NULL AND l.supplier_amendment_closed_at IS NOT NULL)
 ORDER BY supplier_amendment_closed_at DESC NULLS LAST,supplier_supply_hold_at DESC NULLS LAST,l.id LIMIT 1;
 IF FOUND THEN
  NEW.supplier_amendment_parent_line_id:=current_hold.id;
  NEW.supplier_supply_hold_id:=current_hold.supplier_supply_hold_id;
  NEW.supplier_supply_hold_at:=current_hold.supplier_supply_hold_at;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inherit_supplier_incoming_evidence BEFORE INSERT ON purchase_order_lines
FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.inherit_supplier_incoming_evidence();

CREATE FUNCTION stockchief_runtime.refresh_order_incoming_evidence(target_workspace text,target_order text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE affected record;
BEGIN
 FOR affected IN SELECT id FROM purchase_order_lines
   WHERE workspace_id=target_workspace AND purchase_order_id=target_order AND supplier_supply_hold_id IS NOT NULL ORDER BY id
 LOOP PERFORM stockchief_runtime.refresh_incoming_evidence(target_workspace,affected.id); END LOOP;
END $$;

CREATE FUNCTION stockchief_runtime.confirmed_supplier_incoming_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_order text;
BEGIN
 SELECT purchase_order_id INTO target_order FROM stockchief_runtime.supplier_order_links
 WHERE workspace_id=NEW.workspace_id AND token_hash=NEW.token_hash;
 PERFORM stockchief_runtime.refresh_order_incoming_evidence(NEW.workspace_id,target_order);
 RETURN NEW;
END $$;
CREATE TRIGGER confirmed_supplier_incoming_evidence AFTER INSERT ON stockchief_runtime.supplier_link_submissions
FOR EACH ROW WHEN (NEW.kind='confirm') EXECUTE FUNCTION stockchief_runtime.confirmed_supplier_incoming_evidence();

CREATE FUNCTION stockchief_runtime.reviewed_supplier_incoming_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM stockchief_runtime.refresh_order_incoming_evidence(NEW.workspace_id,NEW.purchase_order_id);
 RETURN NEW;
END $$;
CREATE TRIGGER matched_supplier_incoming_evidence AFTER INSERT OR UPDATE ON supplier_documents
FOR EACH ROW WHEN (NEW.document_type='order_acknowledgement' AND NEW.status='MATCHED')
EXECUTE FUNCTION stockchief_runtime.reviewed_supplier_incoming_evidence();
CREATE TRIGGER amended_supplier_incoming_evidence AFTER INSERT OR UPDATE ON stockchief_runtime.agent_po_date_sources
FOR EACH ROW WHEN (NEW.processed_at IS NOT NULL)
EXECUTE FUNCTION stockchief_runtime.reviewed_supplier_incoming_evidence();

SELECT stockchief_runtime.refresh_incoming_evidence(workspace_id,line_id)
FROM (SELECT DISTINCT workspace_id,line_id FROM stockchief_runtime.agent_backup_supplier_notices
 WHERE supplier_reply_id IS NOT NULL AND revoked_at IS NULL AND line_id IS NOT NULL
 ORDER BY workspace_id,line_id) original_notices;
