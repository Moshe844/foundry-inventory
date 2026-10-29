-- Capacity is account-wide, including imports, feeds and direct service writes.
ALTER TABLE commercial_meter_definitions DROP CONSTRAINT commercial_meter_definitions_kind_check;
ALTER TABLE commercial_meter_definitions ADD CONSTRAINT commercial_meter_definitions_kind_check CHECK(kind IN ('STRUCTURAL','USAGE','PER_OPERATION'));
INSERT INTO commercial_meter_definitions(meter,label,kind,customer_visible,critical_access) VALUES
 ('active_skus','Active SKUs','STRUCTURAL',1,1),('import_rows','Rows per import','PER_OPERATION',1,1);
INSERT INTO commercial_plan_meters(plan_id,meter,label,included_units,hard_limit,overage_mode)
SELECT p.plan_id,m.meter,m.label,m.units,m.units,'PAUSE' FROM
 (VALUES ('starter',500::bigint,1000::bigint),('growth',25000,100000),('pro',250000,1000000),('enterprise',2000000,5000000)) p(plan_id,skus,rows)
 CROSS JOIN LATERAL (VALUES ('active_skus','Active SKUs',p.skus),('import_rows','Rows per import',p.rows)) m(meter,label,units);
UPDATE commercial_plan_meters product SET included_units=sku.included_units,hard_limit=sku.hard_limit
 FROM commercial_plan_meters sku WHERE product.plan_id=sku.plan_id AND product.meter='products' AND sku.meter='active_skus';
UPDATE commercial_plan_versions v SET meters=(SELECT jsonb_agg(CASE WHEN e->>'meter'='products'
 THEN e||jsonb_build_object('included_units',p.included_units,'hard_limit',p.hard_limit) ELSE e END)
 FROM jsonb_array_elements(v.meters) e CROSS JOIN commercial_plan_meters p WHERE p.plan_id=v.plan_id AND p.meter='products')
 WHERE v.status='ACTIVE';
-- Preserve existing versioned commercial terms; append only the newly introduced limits.
UPDATE commercial_plan_versions v SET meters=v.meters || COALESCE((SELECT jsonb_agg(to_jsonb(m))
 FROM commercial_plan_meters m WHERE m.plan_id=v.plan_id AND m.meter IN ('active_skus','import_rows')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v.meters) e WHERE e->>'meter'=m.meter)),'[]'::jsonb);

CREATE TABLE stockchief_runtime.inventory_capacity (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 active_skus bigint NOT NULL DEFAULT 0 CHECK(active_skus>=0),
 active_products bigint NOT NULL DEFAULT 0 CHECK(active_products>=0)
);
INSERT INTO stockchief_runtime.inventory_capacity(workspace_id,active_skus)
SELECT w.id,count(s.id) FROM workspaces w LEFT JOIN items i ON i.workspace_id=w.id AND i.is_active=1
 LEFT JOIN skus s ON s.item_id=i.id AND s.is_active=1 GROUP BY w.id;
UPDATE stockchief_runtime.inventory_capacity c SET active_products=(SELECT count(*) FROM items i WHERE i.workspace_id=c.workspace_id AND i.is_active=1);

CREATE FUNCTION stockchief_capacity_limit(w text,m text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE a text; p text; v text; lim bigint; pol jsonb;
BEGIN
 SELECT owner_account_id INTO a FROM workspaces WHERE id=w;
 SELECT plan_id,plan_version_id INTO p,v FROM account_subscriptions WHERE account_id=a;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT limit_units INTO lim FROM commercial_entitlement_overrides WHERE meter=m
  AND (account_id=a OR workspace_id=w) AND starts_at<=now() AND (ends_at IS NULL OR ends_at>now())
  ORDER BY CASE WHEN workspace_id IS NOT NULL THEN 0 ELSE 1 END,created_at DESC LIMIT 1;
 IF FOUND THEN RETURN lim; END IF;
 SELECT e INTO pol FROM commercial_plan_versions pv CROSS JOIN LATERAL jsonb_array_elements(pv.meters) e
  WHERE pv.id=v AND pv.plan_id=p AND e->>'meter'=m;
 IF FOUND THEN lim=(pol->>'hard_limit')::bigint;
 ELSE
  SELECT hard_limit INTO lim FROM commercial_plan_meters WHERE plan_id=p AND meter=m;
  IF NOT FOUND THEN lim=0; END IF;
 END IF;
 IF lim IS NOT NULL THEN
  SELECT lim+COALESCE(sum(o.units),0) INTO lim FROM commercial_capacity_orders o
   JOIN commercial_capacity_products product ON product.id=o.product_id
   WHERE o.account_id=a AND (product.meter=m OR (m='active_skus' AND product.meter='products')) AND o.status='ACTIVE' AND o.paid_through>now();
 END IF;
 RETURN lim;
END $$;

CREATE FUNCTION stockchief_adjust_capacity(w text,delta bigint,m text DEFAULT 'active_skus') RETURNS void LANGUAGE plpgsql AS $$
DECLARE a text; lim bigint; used bigint;
BEGIN
 IF delta=0 THEN RETURN; END IF;
 SELECT owner_account_id INTO a FROM workspaces WHERE id=w;
 IF NOT FOUND THEN RETURN; END IF;
 IF delta>0 AND EXISTS(SELECT 1 FROM workspaces WHERE id=w AND deletion_requested_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Restore this inventory before adding products.' USING ERRCODE='23514',CONSTRAINT='inventory_plan_capacity';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory-capacity:'||a,0));
 INSERT INTO stockchief_runtime.inventory_capacity(workspace_id,active_skus) VALUES(w,0) ON CONFLICT DO NOTHING;
 UPDATE stockchief_runtime.inventory_capacity SET active_skus=active_skus+CASE WHEN m='active_skus' THEN delta ELSE 0 END,
  active_products=active_products+CASE WHEN m='products' THEN delta ELSE 0 END WHERE workspace_id=w;
 IF delta>0 THEN
  lim=stockchief_capacity_limit(w,m);
  SELECT sum(CASE WHEN m='products' THEN c.active_products ELSE c.active_skus END) INTO used FROM stockchief_runtime.inventory_capacity c JOIN workspaces ws ON ws.id=c.workspace_id
   WHERE ws.owner_account_id=a AND ws.deletion_requested_at IS NULL;
  IF lim IS NOT NULL AND used>lim THEN RAISE EXCEPTION '% exceed the account plan limit of %. Archive products or upgrade before adding more.',CASE WHEN m='products' THEN 'Products' ELSE 'Active SKUs' END,lim
   USING ERRCODE='23514',CONSTRAINT='inventory_plan_capacity'; END IF;
 END IF;
END $$;
CREATE FUNCTION stockchief_sku_capacity_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_count bigint=0; new_count bigint=0; w text;
BEGIN
 IF TG_OP<>'INSERT' THEN
  w=OLD.workspace_id;
  SELECT OLD.is_active*i.is_active INTO old_count FROM items i WHERE i.id=OLD.item_id FOR SHARE;
 END IF;
 IF TG_OP<>'DELETE' THEN
  w=NEW.workspace_id;
  IF TG_OP='UPDATE' AND (NEW.workspace_id<>OLD.workspace_id OR NEW.item_id<>OLD.item_id) THEN
   RAISE EXCEPTION 'Move inventory through an audited migration, not by changing SKU ownership.';
  END IF;
  SELECT NEW.is_active*i.is_active INTO new_count FROM items i WHERE i.id=NEW.item_id FOR SHARE;
 END IF;
 PERFORM stockchief_adjust_capacity(w,COALESCE(new_count,0)-COALESCE(old_count,0));
 RETURN NULL;
END $$;
-- Bulk imports charge the account once per statement. Updating one workspace
-- counter for every inserted variant makes large batches quadratic in MVCC work.
CREATE FUNCTION stockchief_sku_capacity_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
 PERFORM 1 FROM items WHERE id IN (SELECT item_id FROM inserted_skus) ORDER BY id FOR SHARE;
 FOR r IN SELECT s.workspace_id,sum(s.is_active*i.is_active)::bigint AS delta
  FROM inserted_skus s JOIN items i ON i.id=s.item_id GROUP BY s.workspace_id ORDER BY s.workspace_id LOOP
  PERFORM stockchief_adjust_capacity(r.workspace_id,r.delta);
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER sku_capacity_inserted AFTER INSERT ON skus REFERENCING NEW TABLE AS inserted_skus
 FOR EACH STATEMENT EXECUTE FUNCTION stockchief_sku_capacity_inserted();
CREATE TRIGGER sku_capacity_changed AFTER UPDATE OR DELETE ON skus FOR EACH ROW EXECUTE FUNCTION stockchief_sku_capacity_changed();
CREATE FUNCTION stockchief_item_capacity_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
 FOR r IN SELECT workspace_id,sum(is_active)::bigint AS delta FROM inserted_items GROUP BY workspace_id ORDER BY workspace_id LOOP
  PERFORM stockchief_adjust_capacity(r.workspace_id,r.delta,'products');
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER item_capacity_inserted AFTER INSERT ON items REFERENCING NEW TABLE AS inserted_items
 FOR EACH STATEMENT EXECUTE FUNCTION stockchief_item_capacity_inserted();
CREATE FUNCTION stockchief_item_capacity_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delta bigint;
BEGIN
 IF TG_OP='DELETE' THEN delta=-OLD.is_active;
 ELSE
  IF NEW.workspace_id<>OLD.workspace_id THEN RAISE EXCEPTION 'Item ownership cannot be changed directly.'; END IF;
  delta=NEW.is_active-OLD.is_active;
 END IF;
 IF delta<>0 THEN
  PERFORM stockchief_adjust_capacity(OLD.workspace_id,delta,'products');
  PERFORM stockchief_adjust_capacity(OLD.workspace_id,delta*(SELECT count(*) FROM skus WHERE item_id=OLD.id AND is_active=1));
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER item_capacity_updated AFTER UPDATE ON items FOR EACH ROW EXECUTE FUNCTION stockchief_item_capacity_changed();
CREATE TRIGGER item_capacity_deleted BEFORE DELETE ON items FOR EACH ROW EXECUTE FUNCTION stockchief_item_capacity_changed();
CREATE FUNCTION stockchief_import_capacity_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lim bigint;
BEGIN
 lim=stockchief_capacity_limit(NEW.workspace_id,'import_rows');
 IF lim IS NOT NULL AND NEW.records_detected>lim THEN RAISE EXCEPTION 'Import has % rows; the current plan allows % rows per import.',NEW.records_detected,lim
  USING ERRCODE='23514',CONSTRAINT='inventory_plan_capacity'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER import_capacity_changed BEFORE INSERT OR UPDATE OF records_detected,approval_status,status ON import_plans
 FOR EACH ROW WHEN (NEW.status NOT IN ('SUCCEEDED','FAILED','CANCELLED')) EXECUTE FUNCTION stockchief_import_capacity_changed();

CREATE FUNCTION stockchief_workspace_capacity_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lim bigint; used bigint; a text; m text;
BEGIN
 IF NEW.deletion_requested_at IS NOT NULL THEN RETURN NULL; END IF;
 IF OLD.owner_account_id IS NOT DISTINCT FROM NEW.owner_account_id AND OLD.deletion_requested_at IS NULL THEN RETURN NULL; END IF;
 FOR a IN SELECT DISTINCT owner FROM unnest(ARRAY[OLD.owner_account_id,NEW.owner_account_id]) owner ORDER BY owner LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('inventory-capacity:'||a,0));
 END LOOP;
 FOR m IN SELECT unnest(ARRAY['active_skus','products']) LOOP
 lim=stockchief_capacity_limit(NEW.id,m);
 SELECT COALESCE(sum(CASE WHEN m='products' THEN c.active_products ELSE c.active_skus END),0) INTO used FROM stockchief_runtime.inventory_capacity c
  JOIN workspaces w ON w.id=c.workspace_id WHERE w.owner_account_id=NEW.owner_account_id AND w.deletion_requested_at IS NULL;
 IF lim IS NOT NULL AND used>lim THEN RAISE EXCEPTION 'Restoring or transferring this inventory exceeds the account active SKU limit of %.',lim
  USING ERRCODE='23514',CONSTRAINT='inventory_plan_capacity'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER workspace_capacity_changed AFTER UPDATE OF owner_account_id,deletion_requested_at ON workspaces
 FOR EACH ROW EXECUTE FUNCTION stockchief_workspace_capacity_changed();
