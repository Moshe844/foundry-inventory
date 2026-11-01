-- Keep physical and cost quantities independently: a surplus of costed units
-- at one location must never conceal missing purchase costs at another.
CREATE TABLE inventory_cost_coverage_positions(
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id TEXT NOT NULL,
 location_id TEXT NOT NULL,
 physical_units NUMERIC NOT NULL DEFAULT 0,
 costed_units NUMERIC NOT NULL DEFAULT 0,
 book_cost_minor NUMERIC NOT NULL DEFAULT 0,
 missing_units NUMERIC GENERATED ALWAYS AS (GREATEST(physical_units-costed_units,0)) STORED,
 PRIMARY KEY(workspace_id,sku_id,location_id)
);
CREATE TABLE inventory_cost_coverage_totals(
 workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 physical_units NUMERIC NOT NULL,
 costed_units NUMERIC NOT NULL,
 book_cost_minor NUMERIC NOT NULL,
 missing_units NUMERIC NOT NULL
);
CREATE FUNCTION stockchief_sum_cost_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO inventory_cost_coverage_totals AS totals(workspace_id,physical_units,costed_units,book_cost_minor,missing_units)
  SELECT p.workspace_id,sum(p.physical_units),sum(p.costed_units),sum(p.book_cost_minor),sum(p.missing_units)
  FROM new_coverage p JOIN workspaces w ON w.id=p.workspace_id GROUP BY p.workspace_id ORDER BY p.workspace_id
  ON CONFLICT(workspace_id) DO UPDATE SET physical_units=totals.physical_units+EXCLUDED.physical_units,
   costed_units=totals.costed_units+EXCLUDED.costed_units,book_cost_minor=totals.book_cost_minor+EXCLUDED.book_cost_minor,
   missing_units=totals.missing_units+EXCLUDED.missing_units;
 ELSE
  INSERT INTO inventory_cost_coverage_totals AS totals(workspace_id,physical_units,costed_units,book_cost_minor,missing_units)
  SELECT p.workspace_id,sum(p.physical_units-o.physical_units),sum(p.costed_units-o.costed_units),
   sum(p.book_cost_minor-o.book_cost_minor),sum(p.missing_units-o.missing_units)
  FROM new_coverage p JOIN old_coverage o USING(workspace_id,sku_id,location_id)
  JOIN workspaces w ON w.id=p.workspace_id GROUP BY p.workspace_id ORDER BY p.workspace_id
  ON CONFLICT(workspace_id) DO UPDATE SET physical_units=totals.physical_units+EXCLUDED.physical_units,
   costed_units=totals.costed_units+EXCLUDED.costed_units,book_cost_minor=totals.book_cost_minor+EXCLUDED.book_cost_minor,
   missing_units=totals.missing_units+EXCLUDED.missing_units;
 END IF;
 RETURN NULL;
END;
$$;
CREATE TRIGGER cost_coverage_insert AFTER INSERT ON inventory_cost_coverage_positions
 REFERENCING NEW TABLE AS new_coverage FOR EACH STATEMENT EXECUTE FUNCTION stockchief_sum_cost_coverage();
CREATE TRIGGER cost_coverage_update AFTER UPDATE ON inventory_cost_coverage_positions
 REFERENCING NEW TABLE AS new_coverage OLD TABLE AS old_coverage FOR EACH STATEMENT EXECUTE FUNCTION stockchief_sum_cost_coverage();

CREATE FUNCTION stockchief_physical_cost_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  INSERT INTO inventory_cost_coverage_positions AS p(workspace_id,sku_id,location_id,physical_units)
  SELECT n.workspace_id,n.sku_id,n.location_id,0 FROM changed_positions n JOIN workspaces w ON w.id=n.workspace_id
  ORDER BY n.workspace_id,n.sku_id,n.location_id
  ON CONFLICT(workspace_id,sku_id,location_id) DO UPDATE SET physical_units=0 WHERE p.physical_units<>0;
 ELSE
  INSERT INTO inventory_cost_coverage_positions AS p(workspace_id,sku_id,location_id,physical_units)
  SELECT n.workspace_id,n.sku_id,n.location_id,n.on_hand FROM changed_positions n
  ORDER BY n.workspace_id,n.sku_id,n.location_id
  ON CONFLICT(workspace_id,sku_id,location_id) DO UPDATE SET physical_units=EXCLUDED.physical_units
  WHERE p.physical_units IS DISTINCT FROM EXCLUDED.physical_units;
 END IF;
 RETURN NULL;
END;
$$;
CREATE FUNCTION stockchief_recorded_cost_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  INSERT INTO inventory_cost_coverage_positions AS p(workspace_id,sku_id,location_id,costed_units,book_cost_minor)
  SELECT n.workspace_id,n.sku_id,n.location_id,0,0 FROM changed_positions n JOIN workspaces w ON w.id=n.workspace_id
  ORDER BY n.workspace_id,n.sku_id,n.location_id
  ON CONFLICT(workspace_id,sku_id,location_id) DO UPDATE SET costed_units=0,book_cost_minor=0
  WHERE p.costed_units<>0 OR p.book_cost_minor<>0;
 ELSE
  INSERT INTO inventory_cost_coverage_positions AS p(workspace_id,sku_id,location_id,costed_units,book_cost_minor)
  SELECT n.workspace_id,n.sku_id,n.location_id,n.quantity_units,n.total_cost_minor FROM changed_positions n
  ORDER BY n.workspace_id,n.sku_id,n.location_id
  ON CONFLICT(workspace_id,sku_id,location_id) DO UPDATE SET costed_units=EXCLUDED.costed_units,book_cost_minor=EXCLUDED.book_cost_minor
  WHERE (p.costed_units,p.book_cost_minor) IS DISTINCT FROM (EXCLUDED.costed_units,EXCLUDED.book_cost_minor);
 END IF;
 RETURN NULL;
END;
$$;
-- Creating the triggers locks both sources until the initial projection and
-- its totals commit; concurrent receipts cannot fall through the backfill.
-- Run after read_model_* on both sources to retain the same lock order.
CREATE TRIGGER zz_physical_coverage_insert AFTER INSERT ON balances REFERENCING NEW TABLE AS changed_positions FOR EACH STATEMENT EXECUTE FUNCTION stockchief_physical_cost_coverage();
CREATE TRIGGER zz_physical_coverage_update AFTER UPDATE ON balances REFERENCING NEW TABLE AS changed_positions FOR EACH STATEMENT EXECUTE FUNCTION stockchief_physical_cost_coverage();
CREATE TRIGGER zz_physical_coverage_delete AFTER DELETE ON balances REFERENCING OLD TABLE AS changed_positions FOR EACH STATEMENT EXECUTE FUNCTION stockchief_physical_cost_coverage();
CREATE TRIGGER zz_recorded_coverage_insert AFTER INSERT ON accounting_inventory_cost_balances REFERENCING NEW TABLE AS changed_positions FOR EACH STATEMENT EXECUTE FUNCTION stockchief_recorded_cost_coverage();
CREATE TRIGGER zz_recorded_coverage_update AFTER UPDATE ON accounting_inventory_cost_balances REFERENCING NEW TABLE AS changed_positions FOR EACH STATEMENT EXECUTE FUNCTION stockchief_recorded_cost_coverage();
CREATE TRIGGER zz_recorded_coverage_delete AFTER DELETE ON accounting_inventory_cost_balances REFERENCING OLD TABLE AS changed_positions FOR EACH STATEMENT EXECUTE FUNCTION stockchief_recorded_cost_coverage();
INSERT INTO inventory_cost_coverage_positions(workspace_id,sku_id,location_id,physical_units,costed_units,book_cost_minor)
 SELECT coalesce(b.workspace_id,c.workspace_id),coalesce(b.sku_id,c.sku_id),coalesce(b.location_id,c.location_id),
 coalesce(b.on_hand,0),coalesce(c.quantity_units,0),coalesce(c.total_cost_minor,0)
 FROM balances b FULL JOIN accounting_inventory_cost_balances c USING(workspace_id,sku_id,location_id);
