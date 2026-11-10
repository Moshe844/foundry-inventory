ALTER TABLE sales_order_allocations ADD COLUMN rotation_strategy text CHECK(rotation_strategy IN ('FIFO','FEFO')),
 ADD COLUMN rotation_selection jsonb,ADD COLUMN rotation_authorized_by text REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sales_order_kit_allocations ADD COLUMN rotation_strategy text CHECK(rotation_strategy IN ('FIFO','FEFO')),
 ADD COLUMN rotation_selection jsonb,ADD COLUMN rotation_authorized_by text REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sales_order_allocations ADD CONSTRAINT sales_rotation_pair CHECK((rotation_strategy IS NULL)=(rotation_selection IS NULL));
ALTER TABLE sales_order_kit_allocations ADD CONSTRAINT kit_rotation_pair CHECK((rotation_strategy IS NULL)=(rotation_selection IS NULL));
CREATE INDEX sales_rotation_positions ON sales_order_allocations(workspace_id,location_id) WHERE rotation_selection IS NOT NULL;
CREATE INDEX kit_rotation_positions ON sales_order_kit_allocations(workspace_id,location_id) WHERE rotation_selection IS NOT NULL;
CREATE TABLE stockchief_runtime.stock_rotation_locks(workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,revision bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,sku_id,location_id));

CREATE VIEW stockchief_runtime.sales_rotation_entries WITH(security_invoker=true) AS
 SELECT a.workspace_id,'sales:'||a.id allocation_key,a.id allocation_id,'sales'::text allocation_kind,l.sales_order_id,l.sku_id,a.location_id,a.rotation_strategy,
 x.ordinality entry_number,x.value selection,(x.value->>'quantity')::numeric quantity,x.value->>'lotId' lot_id,x.value->>'serialUnitId' serial_unit_id,
 x.value->>'receiptMovementId' receipt_movement_id,(x.value->>'secondaryQuantity')::numeric secondary_quantity
 FROM public.sales_order_allocations a JOIN public.sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id
 CROSS JOIN LATERAL jsonb_array_elements(a.rotation_selection) WITH ORDINALITY x(value,ordinality)
 UNION ALL SELECT a.workspace_id,'kit:'||a.id,a.id,'kit',l.sales_order_id,k.component_sku_id,a.location_id,a.rotation_strategy,
 x.ordinality,x.value,(x.value->>'quantity')::numeric,x.value->>'lotId',x.value->>'serialUnitId',x.value->>'receiptMovementId',(x.value->>'secondaryQuantity')::numeric
 FROM public.sales_order_kit_allocations a JOIN public.sales_order_kit_components k ON k.workspace_id=a.workspace_id AND k.id=a.kit_component_id
 JOIN public.sales_order_lines l ON l.workspace_id=k.workspace_id AND l.id=k.sales_order_line_id
 CROSS JOIN LATERAL jsonb_array_elements(a.rotation_selection) WITH ORDINALITY x(value,ordinality);

CREATE FUNCTION stockchief_runtime.check_rotation_selection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE amount numeric;entry jsonb;product text;kind text;grant_key text;
BEGIN
 kind:=CASE WHEN TG_TABLE_NAME='sales_order_allocations' THEN 'sales:' ELSE 'kit:' END;
 grant_key:=coalesce(current_setting('stockchief.rotation_allocation',true),'');
 IF TG_OP='UPDATE' AND (NEW.rotation_selection,NEW.rotation_strategy,NEW.quantity,NEW.location_id) IS NOT DISTINCT FROM (OLD.rotation_selection,OLD.rotation_strategy,OLD.quantity,OLD.location_id) THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' AND OLD.rotation_selection IS NOT NULL AND NEW.location_id<>OLD.location_id THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Release the FIFO/FEFO identities before changing their stock location.';
 END IF;
 IF NEW.rotation_selection IS NULL THEN RETURN NEW; END IF;
 IF jsonb_typeof(NEW.rotation_selection)<>'array' OR jsonb_array_length(NEW.rotation_selection)=0 THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='A stock rotation reservation needs exact native selections.';
 END IF;
 IF TG_TABLE_NAME='sales_order_allocations' THEN SELECT sku_id INTO product FROM sales_order_lines WHERE workspace_id=NEW.workspace_id AND id=NEW.sales_order_line_id;
 ELSE SELECT component_sku_id INTO product FROM sales_order_kit_components WHERE workspace_id=NEW.workspace_id AND id=NEW.kit_component_id;END IF;
 amount:=0;
 FOR entry IN SELECT value FROM jsonb_array_elements(NEW.rotation_selection) LOOP
  IF (entry->>'quantity')::numeric<=0 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Rotation quantities must be positive.';END IF;
  amount:=amount+(entry->>'quantity')::numeric;
  IF entry->>'lotId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lots WHERE workspace_id=NEW.workspace_id AND sku_id=product AND id=entry->>'lotId') THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='A selected lot must belong to the allocated product.';END IF;
  IF entry->>'serialUnitId' IS NOT NULL THEN
   IF (entry->>'quantity')::numeric<>1 OR NOT EXISTS(SELECT 1 FROM serial_units WHERE workspace_id=NEW.workspace_id AND sku_id=product AND location_id=NEW.location_id AND status='in_stock' AND id=entry->>'serialUnitId')
   OR EXISTS(SELECT 1 FROM stockchief_runtime.sales_rotation_entries r WHERE r.workspace_id=NEW.workspace_id AND r.serial_unit_id=entry->>'serialUnitId' AND r.allocation_key<>kind||NEW.id) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='A selected serial is unavailable or already reserved.';END IF;
  END IF;
 END LOOP;
 IF amount<>NEW.quantity AND NOT(grant_key=kind||NEW.id AND amount<NEW.quantity) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='The FIFO/FEFO identities must cover the exact native allocation. Release them before changing its quantity.';END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER sales_rotation_selection BEFORE INSERT OR UPDATE ON sales_order_allocations FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.check_rotation_selection();
CREATE TRIGGER kit_rotation_selection BEFORE INSERT OR UPDATE ON sales_order_kit_allocations FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.check_rotation_selection();

CREATE FUNCTION stockchief_runtime.guard_rotated_stock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE protected numeric;grant_key text;product text;
BEGIN
 grant_key:=coalesce(current_setting('stockchief.rotation_allocation',true),'');
 IF TG_TABLE_NAME='serial_units' THEN
  IF (NEW.status,NEW.location_id,NEW.sku_id) IS DISTINCT FROM (OLD.status,OLD.location_id,OLD.sku_id) AND EXISTS(
   SELECT 1 FROM stockchief_runtime.sales_rotation_entries r WHERE r.workspace_id=OLD.workspace_id AND r.serial_unit_id=OLD.id AND r.allocation_key<>grant_key) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='This serial is reserved by its exact FIFO/FEFO customer allocation.';END IF;RETURN NEW;
 ELSIF TG_TABLE_NAME='lot_balances' THEN
  IF NEW.quantity>=OLD.quantity THEN RETURN NEW;END IF;
  SELECT coalesce(sum(r.quantity),0) INTO protected FROM stockchief_runtime.sales_rotation_entries r
   WHERE r.workspace_id=NEW.workspace_id AND r.lot_id=NEW.lot_id AND r.location_id=NEW.location_id AND r.allocation_key<>grant_key;
  IF NEW.quantity<protected THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='This lot quantity is reserved by FIFO/FEFO customer allocations.';END IF;RETURN NEW;
 ELSE
  IF NEW.on_hand>=OLD.on_hand THEN RETURN NEW;END IF;
  SELECT coalesce(sum(r.quantity),0) INTO protected FROM stockchief_runtime.sales_rotation_entries r
   WHERE r.workspace_id=NEW.workspace_id AND r.sku_id=NEW.sku_id AND r.location_id=NEW.location_id AND r.allocation_key<>grant_key;
  IF NEW.on_hand<protected THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Stock is reserved by FIFO/FEFO customer allocations. Use or release the original reservation.';END IF;RETURN NEW;
 END IF;
END;$$;
CREATE TRIGGER protect_rotated_balance BEFORE UPDATE ON balances FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.guard_rotated_stock();
CREATE TRIGGER protect_rotated_lot BEFORE UPDATE ON lot_balances FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.guard_rotated_stock();
CREATE TRIGGER protect_rotated_serial BEFORE UPDATE ON serial_units FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.guard_rotated_stock();

CREATE FUNCTION stockchief_runtime.guard_rotation_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source text;product text;batch text;reserved numeric;requested numeric;physical numeric;
BEGIN
 IF TG_TABLE_NAME='inventory_transfer_serials' THEN
  IF NEW.state IN ('REQUESTED','PICKED') AND EXISTS(SELECT 1 FROM stockchief_runtime.sales_rotation_entries r WHERE r.workspace_id=NEW.workspace_id AND r.serial_unit_id=NEW.serial_unit_id) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='A FIFO/FEFO customer reservation already holds that serial.';END IF;RETURN NEW;
 END IF;
 SELECT source_location_id INTO source FROM inventory_transfers WHERE workspace_id=NEW.workspace_id AND id=NEW.transfer_id AND status IN ('REQUESTED','APPROVED','PICKED');
 IF source IS NULL OR NEW.lot_id IS NULL THEN RETURN NEW;END IF;
 SELECT coalesce(sum(r.quantity),0) INTO reserved FROM stockchief_runtime.sales_rotation_entries r WHERE r.workspace_id=NEW.workspace_id AND r.location_id=source AND r.lot_id=NEW.lot_id;
 IF reserved=0 THEN RETURN NEW;END IF;
 SELECT coalesce(quantity,0) INTO physical FROM lot_balances WHERE workspace_id=NEW.workspace_id AND lot_id=NEW.lot_id AND location_id=source FOR UPDATE;
 SELECT coalesce(sum(CASE t.status WHEN 'REQUESTED' THEN l.requested_quantity ELSE l.approved_quantity END),0) INTO requested FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.workspace_id=l.workspace_id AND t.id=l.transfer_id
 WHERE l.workspace_id=NEW.workspace_id AND t.source_location_id=source AND l.lot_id=NEW.lot_id AND t.status IN ('REQUESTED','APPROVED','PICKED') AND l.id<>NEW.id;
 IF coalesce(physical,0)-reserved-requested<(CASE WHEN (SELECT status FROM inventory_transfers WHERE id=NEW.transfer_id)='REQUESTED' THEN NEW.requested_quantity ELSE NEW.approved_quantity END) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='The requested lot is already held by FIFO/FEFO customer reservations.';END IF;RETURN NEW;
END;$$;
CREATE TRIGGER protect_rotated_transfer_lot BEFORE INSERT OR UPDATE ON inventory_transfer_lines FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.guard_rotation_transfer();
CREATE TRIGGER protect_rotated_transfer_serial BEFORE INSERT OR UPDATE ON inventory_transfer_serials FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.guard_rotation_transfer();

-- Receipt layers are logical FIFO custody, never a change to WAC valuation.
-- Only positions explicitly using rotation get a pool and movement processing.
CREATE TABLE stockchief_runtime.stock_rotation_pools(
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
 location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,initialized_seq bigint NOT NULL,opening_evidence text,
 initialized_by text REFERENCES users(id) ON DELETE SET NULL,PRIMARY KEY(workspace_id,sku_id,location_id));
CREATE TABLE stockchief_runtime.stock_rotation_layers(
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,receipt_movement_id text NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
 sku_id text NOT NULL,location_id text NOT NULL,received_at timestamptz,original_quantity numeric NOT NULL CHECK(original_quantity>0),
 remaining_quantity numeric NOT NULL CHECK(remaining_quantity>=0 AND remaining_quantity<=original_quantity),
 PRIMARY KEY(workspace_id,receipt_movement_id),FOREIGN KEY(workspace_id,sku_id,location_id) REFERENCES stockchief_runtime.stock_rotation_pools(workspace_id,sku_id,location_id) ON DELETE CASCADE);
CREATE INDEX rotation_layers_position ON stockchief_runtime.stock_rotation_layers(workspace_id,sku_id,location_id,received_at,receipt_movement_id) WHERE remaining_quantity>0;
CREATE TABLE stockchief_runtime.stock_rotation_layer_uses(
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,movement_id text NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
 receipt_movement_id text NOT NULL,quantity numeric NOT NULL CHECK(quantity>0),PRIMARY KEY(workspace_id,movement_id,receipt_movement_id),
 FOREIGN KEY(workspace_id,receipt_movement_id) REFERENCES stockchief_runtime.stock_rotation_layers(workspace_id,receipt_movement_id) ON DELETE CASCADE);
CREATE FUNCTION stockchief_runtime.track_rotation_layers() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m record;layer record;needed numeric;take numeric;grant_key text;
BEGIN
 grant_key:=coalesce(current_setting('stockchief.rotation_allocation',true),'');
 FOR m IN SELECT changed.* FROM rotation_movements changed JOIN stockchief_runtime.stock_rotation_pools p
  ON p.workspace_id=changed.workspace_id AND p.sku_id=changed.sku_id AND p.location_id=changed.location_id
  WHERE changed.seq>p.initialized_seq ORDER BY changed.seq LOOP
  IF m.quantity_delta>0 THEN
   INSERT INTO stockchief_runtime.stock_rotation_layers(workspace_id,receipt_movement_id,sku_id,location_id,received_at,original_quantity,remaining_quantity)
   VALUES(m.workspace_id,m.id,m.sku_id,m.location_id,CASE WHEN m.operation IN ('receive','transfer') THEN m.occurred_at::timestamptz END,m.quantity_delta,m.quantity_delta);
  ELSE
   needed:=-m.quantity_delta;
   FOR layer IN SELECT l.receipt_movement_id,l.remaining_quantity,least(l.remaining_quantity,sum(r.quantity)) available
    FROM stockchief_runtime.stock_rotation_layers l JOIN stockchief_runtime.sales_rotation_entries r ON r.workspace_id=l.workspace_id AND r.receipt_movement_id=l.receipt_movement_id
    WHERE l.workspace_id=m.workspace_id AND l.sku_id=m.sku_id AND l.location_id=m.location_id AND r.allocation_key=grant_key
    GROUP BY l.receipt_movement_id,l.remaining_quantity,l.received_at ORDER BY l.received_at NULLS LAST,l.receipt_movement_id LOOP
    EXIT WHEN needed<=0;take:=least(needed,layer.available);IF take<=0 THEN CONTINUE;END IF;
    UPDATE stockchief_runtime.stock_rotation_layers SET remaining_quantity=remaining_quantity-take WHERE workspace_id=m.workspace_id AND receipt_movement_id=layer.receipt_movement_id;
    INSERT INTO stockchief_runtime.stock_rotation_layer_uses VALUES(m.workspace_id,m.id,layer.receipt_movement_id,take);needed:=needed-take;
   END LOOP;
   FOR layer IN SELECT l.receipt_movement_id,greatest(0,l.remaining_quantity-coalesce((SELECT sum(r.quantity) FROM stockchief_runtime.sales_rotation_entries r
     WHERE r.workspace_id=l.workspace_id AND r.receipt_movement_id=l.receipt_movement_id AND r.allocation_key<>grant_key),0)) available
    FROM stockchief_runtime.stock_rotation_layers l WHERE l.workspace_id=m.workspace_id AND l.sku_id=m.sku_id AND l.location_id=m.location_id AND l.remaining_quantity>0
    ORDER BY l.received_at NULLS LAST,l.receipt_movement_id FOR UPDATE LOOP
    EXIT WHEN needed<=0;take:=least(needed,layer.available);IF take<=0 THEN CONTINUE;END IF;
    UPDATE stockchief_runtime.stock_rotation_layers SET remaining_quantity=remaining_quantity-take WHERE workspace_id=m.workspace_id AND receipt_movement_id=layer.receipt_movement_id;
    INSERT INTO stockchief_runtime.stock_rotation_layer_uses VALUES(m.workspace_id,m.id,layer.receipt_movement_id,take) ON CONFLICT(workspace_id,movement_id,receipt_movement_id) DO UPDATE SET quantity=stock_rotation_layer_uses.quantity+EXCLUDED.quantity;
    needed:=needed-take;
   END LOOP;
   IF needed>0 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Unreserved FIFO receipt layers no longer cover this issue. Release or use the exact customer reservation.';END IF;
  END IF;
 END LOOP;
 RETURN NULL;
END;$$;
CREATE TRIGGER track_native_rotation_layers AFTER INSERT ON movements REFERENCING NEW TABLE AS rotation_movements FOR EACH STATEMENT EXECUTE FUNCTION stockchief_runtime.track_rotation_layers();

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.stock_rotation_locks'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.stock_rotation_pools'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.stock_rotation_layers'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.stock_rotation_layer_uses'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN ('stockchief_runtime.stock_rotation_locks'::regclass,'stockchief_runtime.stock_rotation_pools'::regclass,
 'stockchief_runtime.stock_rotation_layers'::regclass,'stockchief_runtime.stock_rotation_layer_uses'::regclass);
