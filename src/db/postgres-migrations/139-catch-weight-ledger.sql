ALTER TABLE balances ADD COLUMN secondary_on_hand numeric;
ALTER TABLE lot_balances ADD COLUMN secondary_quantity numeric;
ALTER TABLE movements ADD COLUMN secondary_quantity_delta numeric,ADD COLUMN secondary_balance_after numeric;
ALTER TABLE serial_units ADD COLUMN secondary_quantity numeric CHECK(secondary_quantity IS NULL OR secondary_quantity>0);
ALTER TABLE accounting_inventory_cost_balances ADD COLUMN secondary_quantity_units numeric;
ALTER TABLE accounting_inventory_cost_movements ADD COLUMN secondary_quantity_delta numeric,ADD COLUMN balance_secondary_quantity numeric;
ALTER TABLE sales_order_lines ADD COLUMN secondary_quantity_ordered numeric,ADD COLUMN secondary_quantity_fulfilled numeric NOT NULL DEFAULT 0;
ALTER TABLE purchase_order_lines ADD COLUMN secondary_quantity_ordered numeric,ADD COLUMN secondary_quantity_received numeric NOT NULL DEFAULT 0;
ALTER TABLE purchase_order_receipt_lines ADD COLUMN secondary_quantity numeric;
ALTER TABLE adjustments ADD COLUMN secondary_expected_qty numeric,ADD COLUMN secondary_counted_qty numeric;

CREATE FUNCTION stockchief_secondary_precision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_row record; value numeric;
BEGIN
 SELECT i.secondary_unit_label,i.secondary_precision,i.secondary_increment INTO item_row FROM items i JOIN skus s ON s.workspace_id=i.workspace_id AND s.item_id=i.id WHERE s.workspace_id=NEW.workspace_id AND s.id=NEW.sku_id FOR SHARE OF i;
 IF TG_TABLE_NAME='balances' THEN value:=NEW.secondary_on_hand; ELSE value:=NEW.secondary_quantity_delta; END IF;
 IF item_row.secondary_unit_label IS NULL THEN
  IF value IS NOT NULL THEN RAISE EXCEPTION 'This product does not use a second stocking measure.' USING ERRCODE='23514',CONSTRAINT='stock_quantity_precision';END IF;
 ELSIF value IS NOT NULL AND (value<>round(value,item_row.secondary_precision) OR mod(value,item_row.secondary_increment)<>0 OR abs(value)*power(10::numeric,item_row.secondary_precision)>9007199254740991) THEN
  RAISE EXCEPTION 'Actual stock weight must match the product precision and increment.' USING ERRCODE='23514',CONSTRAINT='stock_quantity_precision';
 END IF;
 IF TG_TABLE_NAME='movements' THEN
 IF item_row.secondary_unit_label IS NOT NULL AND (value IS NULL OR (NEW.quantity_delta>0 AND value<=0) OR (NEW.quantity_delta<0 AND value>=0)) THEN
  RAISE EXCEPTION 'Every catch-weight movement needs its actual measured weight.' USING ERRCODE='23514',CONSTRAINT='stock_quantity_precision';
 END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER secondary_precision_guard BEFORE INSERT OR UPDATE ON balances FOR EACH ROW EXECUTE FUNCTION stockchief_secondary_precision_guard();
CREATE TRIGGER secondary_precision_guard BEFORE INSERT OR UPDATE ON movements FOR EACH ROW EXECUTE FUNCTION stockchief_secondary_precision_guard();

ALTER TABLE accounting_inventory_cost_establishments ADD COLUMN secondary_quantity numeric;
DO $$ DECLARE check_row record; BEGIN
 FOR check_row IN SELECT conname FROM pg_constraint WHERE conrelid='accounting_inventory_cost_establishments'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%total_cost_minor%' AND pg_get_constraintdef(oid) LIKE '%quantity_units%' AND pg_get_constraintdef(oid) LIKE '%unit_cost_minor%'
 LOOP EXECUTE format('ALTER TABLE accounting_inventory_cost_establishments DROP CONSTRAINT %I',check_row.conname); END LOOP;
END; $$;
ALTER TABLE accounting_inventory_cost_establishments ADD CONSTRAINT exact_established_cost CHECK(total_cost_minor=round(coalesce(secondary_quantity,quantity_units)*unit_cost_minor));

ALTER TABLE items ADD CONSTRAINT exact_primary_increment CHECK(quantity_increment=round(quantity_increment,quantity_precision));
ALTER TABLE items ADD CONSTRAINT exact_secondary_increment CHECK(secondary_increment=round(secondary_increment,secondary_precision));
CREATE FUNCTION stockchief_secondary_position_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE position_row record;
BEGIN
 SELECT b.on_hand,b.secondary_on_hand,i.secondary_unit_label INTO position_row FROM balances b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE b.workspace_id=NEW.workspace_id AND b.sku_id=NEW.sku_id AND b.location_id=NEW.location_id;
 IF position_row.secondary_unit_label IS NOT NULL AND (coalesce(position_row.secondary_on_hand,0)<0 OR (position_row.on_hand=0) IS DISTINCT FROM (coalesce(position_row.secondary_on_hand,0)=0)) THEN RAISE EXCEPTION 'Pieces and actual weight must describe the same physical stock position.' USING ERRCODE='23514',CONSTRAINT='stock_quantity_precision';END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER secondary_position_complete AFTER INSERT OR UPDATE ON balances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stockchief_secondary_position_complete();
