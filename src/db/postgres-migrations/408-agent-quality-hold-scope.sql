-- A QC rule names a supplier, a product or both, at one owned receiving
-- location or at all of them. The most specific enabled rule covers each line.
ALTER TABLE stockchief_runtime.agent_quality_policies
 ALTER COLUMN supplier_id DROP NOT NULL,ALTER COLUMN sku_id DROP NOT NULL,ALTER COLUMN location_id DROP NOT NULL;
DO $$DECLARE n text;BEGIN
 FOR n IN SELECT conname FROM pg_constraint WHERE conrelid='stockchief_runtime.agent_quality_policies'::regclass AND contype='u' LOOP
  EXECUTE format('ALTER TABLE stockchief_runtime.agent_quality_policies DROP CONSTRAINT %I',n);
 END LOOP;
END $$;
ALTER TABLE stockchief_runtime.agent_quality_policies ADD CONSTRAINT agent_quality_policy_scope CHECK(supplier_id IS NOT NULL OR sku_id IS NOT NULL);
CREATE UNIQUE INDEX agent_quality_policy_exact_scope ON stockchief_runtime.agent_quality_policies
 (workspace_id,coalesce(supplier_id,''),coalesce(sku_id,''),coalesce(location_id,''));
CREATE INDEX agent_quality_policy_enabled ON stockchief_runtime.agent_quality_policies(workspace_id) WHERE enabled;

-- A matching receipt line records one of five states. PROPOSED and NOT_HELD
-- leave stock available; HELD and FAILED keep the remaining units out of it.
-- Batches and exact serial units travel with the hold, and measured goods keep
-- their exact quantity.
DO $$DECLARE n text;BEGIN
 FOR n IN SELECT conname FROM pg_constraint WHERE conrelid='stockchief_runtime.agent_quality_holds'::regclass AND contype='c' LOOP
  EXECUTE format('ALTER TABLE stockchief_runtime.agent_quality_holds DROP CONSTRAINT %I',n);
 END LOOP;
END $$;
ALTER TABLE stockchief_runtime.agent_quality_holds
 ALTER COLUMN quantity TYPE numeric(20,6),ALTER COLUMN returned_quantity TYPE numeric(20,6),
 ADD COLUMN written_off_quantity numeric(20,6) NOT NULL DEFAULT 0,
 ADD COLUMN lot_id text,
 ADD COLUMN serial_unit_ids text[] NOT NULL DEFAULT '{}',
 ADD COLUMN proposal_reason text,
 ADD COLUMN decided_by text REFERENCES users(id),
 ADD COLUMN decided_at timestamptz,
 ADD COLUMN released_by_rule boolean NOT NULL DEFAULT false;
ALTER TABLE stockchief_runtime.agent_quality_holds
 ADD CONSTRAINT agent_quality_hold_status CHECK(status IN ('PROPOSED','NOT_HELD','HELD','FAILED','PASSED')),
 ADD CONSTRAINT agent_quality_hold_quantities CHECK(quantity>0 AND returned_quantity>=0 AND written_off_quantity>=0
  AND returned_quantity+written_off_quantity<=quantity),
 ADD CONSTRAINT agent_quality_hold_revision CHECK(revision>0),
 ADD CONSTRAINT agent_quality_hold_release CHECK((status='PASSED')=(released_at IS NOT NULL)),
 ADD CONSTRAINT agent_quality_hold_inspection CHECK(status IN ('PROPOSED','NOT_HELD','HELD') OR (inspected_by IS NOT NULL AND inspection IS NOT NULL)),
 ADD CONSTRAINT agent_quality_hold_not_held CHECK(status<>'NOT_HELD' OR proposal_reason IS NOT NULL),
 ADD CONSTRAINT agent_quality_hold_rule_release CHECK(NOT released_by_rule OR status='PASSED');
CREATE INDEX agent_quality_hold_decider ON stockchief_runtime.agent_quality_holds(decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX agent_quality_hold_active ON stockchief_runtime.agent_quality_holds(workspace_id,sku_id,location_id) WHERE status IN ('HELD','FAILED');
CREATE INDEX agent_quality_hold_proposed ON stockchief_runtime.agent_quality_holds(workspace_id,created_at,id) WHERE status='PROPOSED';

CREATE OR REPLACE FUNCTION stockchief_runtime.apply_quality_hold_delta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  UPDATE balances b SET quality_held=b.quality_held+d.quantity FROM
   (SELECT sku_id,location_id,sum(quantity-returned_quantity-written_off_quantity) quantity FROM new_holds
     WHERE status IN ('HELD','FAILED') GROUP BY sku_id,location_id)d
   WHERE b.sku_id=d.sku_id AND b.location_id=d.location_id AND d.quantity<>0;
 ELSIF TG_OP='DELETE' THEN
  UPDATE balances b SET quality_held=b.quality_held-d.quantity FROM
   (SELECT sku_id,location_id,sum(quantity-returned_quantity-written_off_quantity) quantity FROM old_holds
     WHERE status IN ('HELD','FAILED') GROUP BY sku_id,location_id)d
   WHERE b.sku_id=d.sku_id AND b.location_id=d.location_id AND d.quantity<>0;
 ELSE
  UPDATE balances b SET quality_held=b.quality_held+d.quantity FROM
   (SELECT sku_id,location_id,sum(quantity) quantity FROM (
     SELECT sku_id,location_id,quantity-returned_quantity-written_off_quantity AS quantity FROM new_holds WHERE status IN ('HELD','FAILED')
     UNION ALL SELECT sku_id,location_id,returned_quantity+written_off_quantity-quantity FROM old_holds WHERE status IN ('HELD','FAILED')
    )changes GROUP BY sku_id,location_id HAVING sum(quantity)<>0)d
   WHERE b.sku_id=d.sku_id AND b.location_id=d.location_id;
 END IF;
 RETURN NULL;
END $$;

-- Every receipt line covered by an enabled rule records its QC decision, even
-- when nothing is held, so an older writer cannot skip the rule.
CREATE OR REPLACE FUNCTION stockchief_runtime.require_receipt_quality_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.location_id IS NOT NULL AND EXISTS(SELECT 1 FROM purchase_order_receipts r JOIN purchase_orders o ON o.id=r.purchase_order_id AND o.workspace_id=r.workspace_id
   JOIN stockchief_runtime.agent_quality_policies p ON p.workspace_id=o.workspace_id AND p.enabled
    AND (p.supplier_id IS NULL OR p.supplier_id=o.supplier_id) AND (p.sku_id IS NULL OR p.sku_id=NEW.sku_id)
    AND (p.location_id IS NULL OR p.location_id=NEW.location_id)
   WHERE r.id=NEW.receipt_id AND r.workspace_id=NEW.workspace_id)
  AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_quality_holds h WHERE h.receipt_line_id=NEW.id)
 THEN RAISE EXCEPTION 'Quality inspection hold required. Review this delivery using the current receiving form.' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
