ALTER TABLE workspaces ADD COLUMN has_supplier_direct_orders boolean NOT NULL DEFAULT false;

ALTER TABLE purchase_orders
  ADD COLUMN delivery_kind text NOT NULL DEFAULT 'WAREHOUSE' CHECK(delivery_kind IN ('WAREHOUSE','CUSTOMER_DIRECT')),
  ADD COLUMN direct_sales_order_id text REFERENCES sales_orders(id),
  ADD CONSTRAINT direct_purchase_destination CHECK(
    delivery_kind='WAREHOUSE' AND direct_sales_order_id IS NULL OR
    delivery_kind='CUSTOMER_DIRECT' AND direct_sales_order_id IS NOT NULL AND destination_location_id IS NULL
  );

ALTER TABLE sales_order_lines
  ADD COLUMN direct_committed_quantity numeric NOT NULL DEFAULT 0 CHECK(direct_committed_quantity>=0),
  ADD COLUMN direct_committed_secondary_quantity numeric NOT NULL DEFAULT 0 CHECK(direct_committed_secondary_quantity>=0),
  ADD CONSTRAINT direct_promises_within_customer_quantity CHECK(
    direct_committed_quantity+quantity_fulfilled<=quantity_ordered
  ),
  ADD CONSTRAINT direct_promises_within_customer_weight CHECK(
    secondary_quantity_ordered IS NULL AND direct_committed_secondary_quantity=0 OR
    secondary_quantity_ordered IS NOT NULL AND
      direct_committed_secondary_quantity+coalesce(secondary_quantity_fulfilled,0)<=secondary_quantity_ordered
  );
CREATE INDEX direct_customer_promises ON sales_order_lines(workspace_id,id) WHERE direct_committed_quantity>0;

CREATE TABLE stockchief_runtime.agent_direct_orders (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  sales_order_id text NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  purchase_order_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  prepared_by text NOT NULL,
  request_key text NOT NULL,
  request_hash text NOT NULL,
  facts jsonb NOT NULL,
  source_hash text NOT NULL,
  committed_at timestamptz,
  committed_by text,
  stopped_at timestamptz,
  routine boolean NOT NULL DEFAULT false,
  automatic_purchase boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,purchase_order_id),
  UNIQUE(workspace_id,request_key)
);
CREATE INDEX agent_direct_orders_customer ON stockchief_runtime.agent_direct_orders(workspace_id,sales_order_id,id);
CREATE INDEX agent_direct_orders_list ON stockchief_runtime.agent_direct_orders(workspace_id,created_at DESC,id DESC);

CREATE FUNCTION stockchief_runtime.refresh_direct_order_presence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  UPDATE workspaces SET has_supplier_direct_orders=true WHERE id=NEW.workspace_id AND NOT has_supplier_direct_orders;
 ELSE
  UPDATE workspaces SET has_supplier_direct_orders=EXISTS(
   SELECT 1 FROM stockchief_runtime.agent_direct_orders d WHERE d.workspace_id=OLD.workspace_id)
   WHERE id=OLD.workspace_id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER direct_order_presence AFTER INSERT OR DELETE ON stockchief_runtime.agent_direct_orders
 FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.refresh_direct_order_presence();

CREATE TABLE stockchief_runtime.agent_direct_rules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  reference_order_id text NOT NULL,
  supplier_id text NOT NULL REFERENCES suppliers(id),
  customer_id text REFERENCES customers(id),
  sku_ids text[] NOT NULL,
  source_terms jsonb NOT NULL,
  currency text NOT NULL,
  maximum_minor bigint NOT NULL CHECK(maximum_minor>0),
  connector_id text NOT NULL REFERENCES workspace_connectors(id),
  mailbox_account text NOT NULL,
  authorized_by text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  next_check_at timestamptz,
  last_order_at text,
  last_order_id text,
  last_issue text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,reference_order_id) REFERENCES stockchief_runtime.agent_direct_orders(workspace_id,id) ON DELETE CASCADE,
  UNIQUE(workspace_id,reference_order_id)
);
CREATE INDEX agent_direct_rules_due ON stockchief_runtime.agent_direct_rules(workspace_id,next_check_at,id) WHERE enabled;
ALTER TABLE stockchief_runtime.agent_direct_orders ADD COLUMN rule_id text,
  ADD FOREIGN KEY(workspace_id,rule_id) REFERENCES stockchief_runtime.agent_direct_rules(workspace_id,id);

CREATE TABLE stockchief_runtime.agent_direct_order_lines (
  workspace_id text NOT NULL,
  id text NOT NULL,
  direct_order_id text NOT NULL,
  sales_order_line_id text NOT NULL REFERENCES sales_order_lines(id) ON DELETE CASCADE,
  purchase_order_line_id text NOT NULL REFERENCES purchase_order_lines(id) ON DELETE CASCADE,
  quantity numeric NOT NULL CHECK(quantity>0),
  secondary_quantity numeric,
  dispatched_quantity numeric NOT NULL DEFAULT 0 CHECK(dispatched_quantity>=0 AND dispatched_quantity<=quantity),
  dispatched_secondary_quantity numeric NOT NULL DEFAULT 0 CHECK(dispatched_secondary_quantity>=0),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,direct_order_id) REFERENCES stockchief_runtime.agent_direct_orders(workspace_id,id) ON DELETE CASCADE,
  UNIQUE(workspace_id,purchase_order_line_id),
  UNIQUE(workspace_id,direct_order_id,sales_order_line_id),
  CHECK(secondary_quantity IS NULL AND dispatched_secondary_quantity=0 OR
    secondary_quantity>0 AND dispatched_secondary_quantity<=secondary_quantity)
);
CREATE INDEX agent_direct_order_line_customer ON stockchief_runtime.agent_direct_order_lines(workspace_id,sales_order_line_id,direct_order_id);

CREATE TABLE stockchief_runtime.agent_direct_dispatches (
  workspace_id text NOT NULL,
  id text NOT NULL,
  direct_order_id text NOT NULL,
  supplier_reference text NOT NULL,
  source_kind text NOT NULL CHECK(source_kind IN ('OWNER','SUPPLIER_LINK')),
  original jsonb NOT NULL,
  state text NOT NULL DEFAULT 'REVIEW' CHECK(state IN ('REVIEW','APPLIED','STOPPED')),
  confirmed_by text,
  automatic boolean NOT NULL DEFAULT false,
  last_issue text,
  purchase_receipt_id text REFERENCES purchase_order_receipts(id) ON DELETE CASCADE,
  shipment_id text REFERENCES sales_shipments(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,direct_order_id) REFERENCES stockchief_runtime.agent_direct_orders(workspace_id,id) ON DELETE CASCADE,
  UNIQUE(workspace_id,direct_order_id,supplier_reference)
);

CREATE TABLE stockchief_runtime.agent_direct_dispatch_lines (
  workspace_id text NOT NULL,
  id text NOT NULL,
  dispatch_id text NOT NULL,
  direct_order_line_id text NOT NULL,
  quantity numeric NOT NULL CHECK(quantity>0),
  secondary_quantity numeric,
  tracking jsonb NOT NULL,
  cost_minor bigint,
  journal_entry_id text REFERENCES accounting_journal_entries(id),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,dispatch_id) REFERENCES stockchief_runtime.agent_direct_dispatches(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,direct_order_line_id) REFERENCES stockchief_runtime.agent_direct_order_lines(workspace_id,id) ON DELETE CASCADE,
  UNIQUE(workspace_id,dispatch_id,direct_order_line_id)
);
CREATE INDEX agent_direct_dispatches_review ON stockchief_runtime.agent_direct_dispatches(workspace_id,direct_order_id,created_at,id)
  WHERE state='REVIEW';

CREATE TABLE stockchief_runtime.agent_direct_lots (
  workspace_id text NOT NULL,
  dispatch_line_id text NOT NULL,
  lot_id text NOT NULL REFERENCES lots(id),
  quantity numeric NOT NULL CHECK(quantity>0),
  secondary_quantity numeric,
  PRIMARY KEY(workspace_id,dispatch_line_id,lot_id),
  FOREIGN KEY(workspace_id,dispatch_line_id) REFERENCES stockchief_runtime.agent_direct_dispatch_lines(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE stockchief_runtime.agent_direct_serial_units (
  workspace_id text NOT NULL,
  dispatch_line_id text NOT NULL,
  serial_unit_id text NOT NULL REFERENCES serial_units(id) ON DELETE CASCADE,
  PRIMARY KEY(workspace_id,serial_unit_id),
  FOREIGN KEY(workspace_id,dispatch_line_id) REFERENCES stockchief_runtime.agent_direct_dispatch_lines(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX agent_direct_serial_dispatch ON stockchief_runtime.agent_direct_serial_units(workspace_id,dispatch_line_id);

-- A direct supplier dispatch is commercial receipt evidence. Its goods have
-- never occupied an owned warehouse location or an inventory movement.
ALTER TABLE purchase_order_receipt_lines
  ALTER COLUMN location_id DROP NOT NULL,
  ADD COLUMN direct_dispatch_line_id text,
  ADD FOREIGN KEY(workspace_id,direct_dispatch_line_id)
    REFERENCES stockchief_runtime.agent_direct_dispatch_lines(workspace_id,id),
  ADD CHECK(direct_dispatch_line_id IS NULL AND location_id IS NOT NULL OR
    direct_dispatch_line_id IS NOT NULL AND location_id IS NULL AND movement_ids::jsonb='[]'::jsonb);
ALTER TABLE sales_shipments
  ADD COLUMN delivery_kind text NOT NULL DEFAULT 'WAREHOUSE' CHECK(delivery_kind IN ('WAREHOUSE','CUSTOMER_DIRECT')),
  ADD COLUMN direct_purchase_order_id text REFERENCES purchase_orders(id),
  ADD CHECK(delivery_kind='WAREHOUSE' AND direct_purchase_order_id IS NULL OR
    delivery_kind='CUSTOMER_DIRECT' AND direct_purchase_order_id IS NOT NULL AND ship_from_location_id IS NULL);
ALTER TABLE sales_shipment_lines
  ALTER COLUMN location_id DROP NOT NULL,
  ADD COLUMN direct_dispatch_line_id text,
  ADD FOREIGN KEY(workspace_id,direct_dispatch_line_id)
    REFERENCES stockchief_runtime.agent_direct_dispatch_lines(workspace_id,id),
  ADD CHECK(direct_dispatch_line_id IS NULL AND location_id IS NOT NULL OR
    direct_dispatch_line_id IS NOT NULL AND location_id IS NULL);
CREATE UNIQUE INDEX direct_receipt_line_once ON purchase_order_receipt_lines(workspace_id,direct_dispatch_line_id)
  WHERE direct_dispatch_line_id IS NOT NULL;
CREATE UNIQUE INDEX direct_shipment_line_once ON sales_shipment_lines(workspace_id,direct_dispatch_line_id)
  WHERE direct_dispatch_line_id IS NOT NULL;

-- Older published servers must preserve promises created by the new workflow.
CREATE FUNCTION stockchief_runtime.check_direct_reservations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_id text; line_row record; normal_quantity numeric;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM sales_order_lines WHERE workspace_id=NEW.workspace_id AND direct_committed_quantity>0 LIMIT 1) THEN
  RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='sales_order_lines' THEN line_id:=NEW.id;
 ELSIF TG_TABLE_NAME='sales_order_allocations' THEN line_id:=NEW.sales_order_line_id;
 ELSE SELECT sales_order_line_id INTO line_id FROM sales_order_kit_components WHERE id=NEW.kit_component_id; END IF;
 SELECT * INTO line_row FROM sales_order_lines WHERE id=line_id;
 IF NOT FOUND OR line_row.direct_committed_quantity=0 THEN RETURN NULL; END IF;
 SELECT coalesce(sum(quantity),0) INTO normal_quantity FROM sales_order_allocations WHERE sales_order_line_id=line_id;
 IF normal_quantity>line_row.quantity_ordered-line_row.quantity_fulfilled-line_row.direct_committed_quantity THEN
  RAISE EXCEPTION 'These customer goods are promised for supplier-direct delivery. Refresh their current reservations.' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM sales_order_kit_components k WHERE k.sales_order_line_id=line_id AND
   (SELECT coalesce(sum(a.quantity),0) FROM sales_order_kit_allocations a WHERE a.kit_component_id=k.id)>
   greatest(0,line_row.quantity_ordered-line_row.quantity_fulfilled-line_row.direct_committed_quantity-normal_quantity)*k.quantity_per_kit) THEN
  RAISE EXCEPTION 'Supplier-direct kits cannot reserve the same goods from local components.' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER direct_sales_promise_reservations AFTER INSERT OR UPDATE ON sales_order_lines
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.direct_committed_quantity>0)
 EXECUTE FUNCTION stockchief_runtime.check_direct_reservations();
CREATE CONSTRAINT TRIGGER direct_normal_reservation_limit AFTER INSERT OR UPDATE ON sales_order_allocations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.check_direct_reservations();
CREATE CONSTRAINT TRIGGER direct_kit_reservation_limit AFTER INSERT OR UPDATE ON sales_order_kit_allocations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.check_direct_reservations();

CREATE FUNCTION stockchief_runtime.protect_direct_customer_promise() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.direct_committed_quantity=0 THEN RETURN OLD; END IF;
 ELSE
  IF NEW.status<>'CANCELLED' THEN RETURN NEW; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND deletion_requested_at IS NULL) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Confirm stopping the supplier delivery before removing this customer line.' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM sales_order_lines
   WHERE workspace_id=NEW.workspace_id AND sales_order_id=NEW.id AND direct_committed_quantity>0) THEN
  RAISE EXCEPTION 'Confirm stopping the supplier delivery before cancelling this customer order.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER direct_customer_line_delete BEFORE DELETE ON sales_order_lines
 FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.protect_direct_customer_promise();
CREATE TRIGGER direct_customer_cancel BEFORE UPDATE OF status ON sales_orders
 FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.protect_direct_customer_promise();

CREATE FUNCTION stockchief_runtime.protect_direct_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_order record;
BEGIN
 SELECT p.status,p.delivery_kind,d.committed_at,d.stopped_at INTO current_order FROM purchase_orders p
 JOIN stockchief_runtime.agent_direct_orders d ON d.workspace_id=p.workspace_id AND d.purchase_order_id=p.id
 WHERE p.id=NEW.id;
 IF NOT FOUND OR current_order.delivery_kind<>'CUSTOMER_DIRECT' THEN RETURN NULL; END IF;
 IF current_order.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED') AND current_order.committed_at IS NULL THEN
  RAISE EXCEPTION 'Approve this purchase through its current supplier-direct customer delivery.' USING ERRCODE='23514';
 ELSIF current_order.status='CANCELLED' AND current_order.committed_at IS NOT NULL AND current_order.stopped_at IS NULL THEN
  RAISE EXCEPTION 'Stop this supplier-direct delivery and release its exact customer promises together.' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER direct_purchase_authority AFTER UPDATE ON purchase_orders
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.delivery_kind='CUSTOMER_DIRECT')
 EXECUTE FUNCTION stockchief_runtime.protect_direct_purchase();

CREATE FUNCTION stockchief_runtime.protect_direct_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM purchase_order_receipts r JOIN purchase_orders p ON p.workspace_id=r.workspace_id AND p.id=r.purchase_order_id
   WHERE r.id=NEW.receipt_id AND p.delivery_kind='CUSTOMER_DIRECT') AND NOT EXISTS(
    SELECT 1 FROM stockchief_runtime.agent_direct_dispatch_lines l JOIN stockchief_runtime.agent_direct_dispatches d
     ON d.workspace_id=l.workspace_id AND d.id=l.dispatch_id WHERE l.workspace_id=NEW.workspace_id
     AND l.id=NEW.direct_dispatch_line_id AND d.state='APPLIED' AND d.purchase_receipt_id=NEW.receipt_id) THEN
  RAISE EXCEPTION 'Record the supplier direct dispatch instead of receiving these goods into a warehouse.' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER direct_receipt_evidence AFTER INSERT OR UPDATE ON purchase_order_receipt_lines
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.protect_direct_receipt();

CREATE FUNCTION stockchief_runtime.protect_direct_serial_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='in_stock' AND EXISTS(SELECT 1 FROM stockchief_runtime.agent_direct_serial_units d
   JOIN serial_units u ON u.workspace_id=d.workspace_id AND u.id=d.serial_unit_id
   WHERE u.workspace_id=NEW.workspace_id AND u.sku_id=NEW.sku_id AND lower(u.serial)=lower(NEW.serial)
     AND u.status='issued' AND u.id<>NEW.id) THEN
  RAISE EXCEPTION 'This serial was delivered directly to a customer. Receive its exact customer return to preserve its identity.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER direct_serial_receipt_identity BEFORE INSERT OR UPDATE ON serial_units
 FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.protect_direct_serial_identity();

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_direct_orders'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_direct_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_direct_order_lines'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_direct_dispatches'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_direct_lots'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_direct_serial_units'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_direct_dispatch_lines'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables r
 WHERE r.relation IN ('stockchief_runtime.agent_direct_orders'::regclass,'stockchief_runtime.agent_direct_rules'::regclass,'stockchief_runtime.agent_direct_order_lines'::regclass,
   'stockchief_runtime.agent_direct_dispatches'::regclass,'stockchief_runtime.agent_direct_dispatch_lines'::regclass,
   'stockchief_runtime.agent_direct_lots'::regclass,'stockchief_runtime.agent_direct_serial_units'::regclass);

-- Default columns add no customer data. Keep the measured bytes for existing
-- native rows unchanged and count the new fields when a direct record uses them.
UPDATE commercial_storage_tables t SET bytes_expression=replace(t.bytes_expression,'to_jsonb(t)',
  format('(CASE WHEN %s THEN to_jsonb(t)-%L::text[] ELSE to_jsonb(t) END)',d.is_default,d.columns))
FROM (VALUES
  ('purchase_orders'::regclass,'t.delivery_kind=''WAREHOUSE''',ARRAY['delivery_kind','direct_sales_order_id']),
  ('sales_order_lines'::regclass,'t.direct_committed_quantity=0 AND t.direct_committed_secondary_quantity=0',
    ARRAY['direct_committed_quantity','direct_committed_secondary_quantity']),
  ('purchase_order_receipt_lines'::regclass,'t.direct_dispatch_line_id IS NULL',ARRAY['direct_dispatch_line_id']),
  ('sales_shipments'::regclass,'t.delivery_kind=''WAREHOUSE''',ARRAY['delivery_kind','direct_purchase_order_id']),
  ('sales_shipment_lines'::regclass,'t.direct_dispatch_line_id IS NULL',ARRAY['direct_dispatch_line_id'])
) d(relation,is_default,columns) WHERE t.relation=d.relation;
