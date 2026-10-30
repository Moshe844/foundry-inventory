ALTER TABLE items
 ADD COLUMN quantity_precision smallint NOT NULL DEFAULT 0 CHECK(quantity_precision BETWEEN 0 AND 6),
 ADD COLUMN quantity_increment numeric NOT NULL DEFAULT 1 CHECK(quantity_increment>0 AND scale(quantity_increment)<=6),
 ADD COLUMN secondary_unit_label text CHECK(secondary_unit_label IS NULL OR (length(btrim(secondary_unit_label)) BETWEEN 1 AND 40 AND lower(btrim(secondary_unit_label))<>lower(btrim(unit_label)))),
 ADD COLUMN secondary_precision smallint NOT NULL DEFAULT 3 CHECK(secondary_precision BETWEEN 0 AND 6),
 ADD COLUMN secondary_increment numeric NOT NULL DEFAULT 0.001 CHECK(secondary_increment>0 AND scale(secondary_increment)<=6),
 ADD CONSTRAINT measured_serial_primary_whole CHECK(tracking_mode<>'serial' OR quantity_precision=0),
 ADD CONSTRAINT measured_dual_primary_whole CHECK(secondary_unit_label IS NULL OR quantity_precision=0);

-- Preserve the reporting view and its explicit access grants while changing
-- physical quantities. Existing integral values stay integral numeric values.
-- Historical CSV row receipts keep their original integral quantity column.
-- Their parser still accepts whole stock units only; rewriting millions of
-- immutable source receipts does not enable measured stock operations.
DO $$
DECLARE view_sql text; old_acl aclitem[]; item record; group_row record; alters text;
BEGIN
 SELECT pg_get_viewdef(c.oid,true),c.relacl INTO view_sql,old_acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='accounting_inventory_cost_events';
 DROP VIEW accounting_inventory_cost_events;
 FOR group_row IN SELECT table_schema,table_name FROM information_schema.columns
  WHERE table_schema IN ('public','stockchief_runtime') AND table_name<>'import_rows' AND data_type IN ('bigint','integer')
   AND (column_name ~ '(^quantity($|_)|_quantity($|_))' OR column_name IN ('on_hand','balance_after','reorder_point','target_stock','safety_stock','physical_units','costed_units_before','expected_qty','counted_qty','units_per_purchase_unit','order_multiple','units_established','over_by_units','confirmed_units','shipping_units','backordered_units','fulfilled_units','committed_units','costed_units_after'))
   AND column_name<>'quantity_tolerance_percent' GROUP BY table_schema,table_name ORDER BY table_schema,table_name
 LOOP
  SELECT string_agg(format('ALTER COLUMN %I TYPE numeric USING %I::numeric',column_name,column_name),', ' ORDER BY ordinal_position) INTO alters FROM information_schema.columns
   WHERE table_schema=group_row.table_schema AND table_name=group_row.table_name AND data_type IN ('bigint','integer')
   AND (column_name ~ '(^quantity($|_)|_quantity($|_))' OR column_name IN ('on_hand','balance_after','reorder_point','target_stock','safety_stock','physical_units','costed_units_before','expected_qty','counted_qty','units_per_purchase_unit','order_multiple','units_established','over_by_units','confirmed_units','shipping_units','backordered_units','fulfilled_units','committed_units','costed_units_after'))
   AND column_name<>'quantity_tolerance_percent';
  EXECUTE format('ALTER TABLE %I.%I %s',group_row.table_schema,group_row.table_name,alters);
 END LOOP;
 EXECUTE 'CREATE VIEW accounting_inventory_cost_events AS '||view_sql;
 FOR item IN SELECT DISTINCT grantee FROM aclexplode((SELECT relacl FROM pg_class WHERE oid='accounting_inventory_cost_events'::regclass)) WHERE grantee<>(SELECT relowner FROM pg_class WHERE oid='accounting_inventory_cost_events'::regclass) LOOP
  EXECUTE 'REVOKE ALL ON accounting_inventory_cost_events FROM '||CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END;
 END LOOP;
 FOR item IN SELECT * FROM aclexplode(old_acl) WHERE grantee<>(SELECT relowner FROM pg_class WHERE oid='accounting_inventory_cost_events'::regclass) LOOP
  EXECUTE 'GRANT '||item.privilege_type||' ON accounting_inventory_cost_events TO '||CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END||CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
 END LOOP;
END; $$;

CREATE OR REPLACE FUNCTION stockchief_adjust_item_location(target_workspace text,target_sku text,target_location text,delta numeric,changed_at text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE target_item text;
BEGIN
 SELECT item_id INTO target_item FROM skus WHERE workspace_id=target_workspace AND id=target_sku;
 IF target_item IS NULL THEN RETURN; END IF;
 INSERT INTO item_location_balances(workspace_id,item_id,location_id,on_hand,updated_at) VALUES(target_workspace,target_item,target_location,delta,changed_at)
 ON CONFLICT(item_id,location_id) DO UPDATE SET on_hand=item_location_balances.on_hand+EXCLUDED.on_hand,updated_at=EXCLUDED.updated_at;
END; $$;

CREATE FUNCTION stockchief_stock_precision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE precision smallint; increment numeric; value numeric;
BEGIN
 SELECT i.quantity_precision,i.quantity_increment INTO precision,increment FROM items i JOIN skus s ON s.workspace_id=i.workspace_id AND s.item_id=i.id WHERE s.workspace_id=NEW.workspace_id AND s.id=NEW.sku_id FOR SHARE OF i;
 IF precision IS NULL THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='balances' THEN value:=NEW.on_hand;
 ELSIF TG_TABLE_NAME='lot_balances' THEN value:=NEW.quantity;
 ELSE value:=NEW.quantity_delta;
 END IF;
 IF value<>round(value,precision) OR mod(value,increment)<>0 THEN RAISE EXCEPTION 'Stock quantity must match this product''s unit precision and increment.' USING ERRCODE='23514',CONSTRAINT='stock_quantity_precision';END IF;
 IF abs(value)*power(10::numeric,precision)>9007199254740991 THEN RAISE EXCEPTION 'Stock quantity exceeds the supported exact range.' USING ERRCODE='23514',CONSTRAINT='stock_quantity_precision';END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER stock_precision_guard BEFORE INSERT OR UPDATE ON balances FOR EACH ROW EXECUTE FUNCTION stockchief_stock_precision_guard();
CREATE TRIGGER stock_precision_guard BEFORE INSERT OR UPDATE ON movements FOR EACH ROW EXECUTE FUNCTION stockchief_stock_precision_guard();
-- Lot positions have no SKU column, so their precision is enforced together
-- with the canonical SKU position by the inventory engine.

CREATE FUNCTION stockchief_unit_definition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.unit_label,NEW.quantity_precision,NEW.quantity_increment,NEW.secondary_unit_label,NEW.secondary_precision,NEW.secondary_increment)
 IS DISTINCT FROM (OLD.unit_label,OLD.quantity_precision,OLD.quantity_increment,OLD.secondary_unit_label,OLD.secondary_precision,OLD.secondary_increment)
 AND (EXISTS(SELECT 1 FROM movements WHERE workspace_id=OLD.workspace_id AND item_id=OLD.id)
 OR EXISTS(SELECT 1 FROM purchase_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id WHERE s.item_id=OLD.id)
 OR EXISTS(SELECT 1 FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id WHERE s.item_id=OLD.id)) THEN
 RAISE EXCEPTION 'Unit settings cannot change after stock or orders have been recorded. Create a new product with the required units.' USING ERRCODE='23514',CONSTRAINT='stock_unit_definition';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER unit_definition_guard BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION stockchief_unit_definition_guard();
