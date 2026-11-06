-- A bulk receipt changes physical stock and recorded cost in one atomic
-- transaction. Capture the final fields in a session-local set and write its
-- coverage once, instead of indexing an intermediate uncosted position and
-- immediately replacing it. Ordinary writers retain their immediate path.
CREATE TABLE stockchief_runtime.import_coverage_transactions(transaction_id xid8 PRIMARY KEY);
CREATE FUNCTION stockchief_prepare_import_coverage() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF to_regclass('pg_temp.stockchief_import_coverage') IS NULL THEN
  CREATE TEMP TABLE stockchief_import_coverage(
   workspace_id text NOT NULL,sku_id text NOT NULL,location_id text NOT NULL,
   physical_units numeric,costed_units numeric,book_cost_minor numeric,
   PRIMARY KEY(workspace_id,sku_id,location_id)) ON COMMIT DELETE ROWS;
 END IF;
END $$;
CREATE FUNCTION stockchief_flush_import_coverage() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF to_regclass('pg_temp.stockchief_import_coverage') IS NULL THEN RETURN; END IF;
 -- NULL means this transaction did not change that side of the position.
 -- Never replace it from an earlier snapshot of another writer's balance.
 INSERT INTO inventory_cost_coverage_positions AS p(workspace_id,sku_id,location_id,physical_units,costed_units,book_cost_minor)
 SELECT n.workspace_id,n.sku_id,n.location_id,n.physical_units,n.costed_units,n.book_cost_minor
 FROM pg_temp.stockchief_import_coverage n JOIN workspaces w ON w.id=n.workspace_id
 WHERE n.physical_units IS NOT NULL AND n.costed_units IS NOT NULL
 ORDER BY n.workspace_id,n.sku_id,n.location_id
 ON CONFLICT(workspace_id,sku_id,location_id) DO UPDATE
 SET physical_units=EXCLUDED.physical_units,costed_units=EXCLUDED.costed_units,book_cost_minor=EXCLUDED.book_cost_minor
 WHERE (p.physical_units,p.costed_units,p.book_cost_minor) IS DISTINCT FROM
       (EXCLUDED.physical_units,EXCLUDED.costed_units,EXCLUDED.book_cost_minor);
 INSERT INTO inventory_cost_coverage_positions AS p(workspace_id,sku_id,location_id,physical_units)
 SELECT n.workspace_id,n.sku_id,n.location_id,n.physical_units
 FROM pg_temp.stockchief_import_coverage n JOIN workspaces w ON w.id=n.workspace_id
 WHERE n.physical_units IS NOT NULL AND n.costed_units IS NULL
 ORDER BY n.workspace_id,n.sku_id,n.location_id
 ON CONFLICT(workspace_id,sku_id,location_id) DO UPDATE SET physical_units=EXCLUDED.physical_units
 WHERE p.physical_units IS DISTINCT FROM EXCLUDED.physical_units;
 INSERT INTO inventory_cost_coverage_positions AS p(workspace_id,sku_id,location_id,costed_units,book_cost_minor)
 SELECT n.workspace_id,n.sku_id,n.location_id,n.costed_units,n.book_cost_minor
 FROM pg_temp.stockchief_import_coverage n JOIN workspaces w ON w.id=n.workspace_id
 WHERE n.physical_units IS NULL AND n.costed_units IS NOT NULL
 ORDER BY n.workspace_id,n.sku_id,n.location_id
 ON CONFLICT(workspace_id,sku_id,location_id) DO UPDATE SET costed_units=EXCLUDED.costed_units,book_cost_minor=EXCLUDED.book_cost_minor
 WHERE (p.costed_units,p.book_cost_minor) IS DISTINCT FROM (EXCLUDED.costed_units,EXCLUDED.book_cost_minor);
 DELETE FROM pg_temp.stockchief_import_coverage;
 DELETE FROM stockchief_runtime.import_coverage_transactions WHERE transaction_id=pg_current_xact_id();
END $$;
CREATE FUNCTION stockchief_commit_import_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM stockchief_flush_import_coverage();RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER import_coverage_complete AFTER INSERT ON stockchief_runtime.import_coverage_transactions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stockchief_commit_import_coverage();

CREATE OR REPLACE FUNCTION stockchief_physical_cost_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('stockchief.defer_import_coverage',true)='on' THEN
  IF NOT EXISTS(SELECT 1 FROM changed_positions) THEN RETURN NULL; END IF;
  PERFORM stockchief_prepare_import_coverage();
  INSERT INTO pg_temp.stockchief_import_coverage AS p(workspace_id,sku_id,location_id,physical_units)
  SELECT workspace_id,sku_id,location_id,CASE WHEN TG_OP='DELETE' THEN 0 ELSE on_hand END FROM changed_positions
  ON CONFLICT(workspace_id,sku_id,location_id) DO UPDATE SET physical_units=EXCLUDED.physical_units;
  INSERT INTO stockchief_runtime.import_coverage_transactions VALUES(pg_current_xact_id()) ON CONFLICT DO NOTHING;
  RETURN NULL;
 END IF;
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
END $$;
CREATE OR REPLACE FUNCTION stockchief_recorded_cost_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('stockchief.defer_import_coverage',true)='on' THEN
  IF NOT EXISTS(SELECT 1 FROM changed_positions) THEN RETURN NULL; END IF;
  PERFORM stockchief_prepare_import_coverage();
  INSERT INTO pg_temp.stockchief_import_coverage AS p(workspace_id,sku_id,location_id,costed_units,book_cost_minor)
  SELECT workspace_id,sku_id,location_id,CASE WHEN TG_OP='DELETE' THEN 0 ELSE quantity_units END,
   CASE WHEN TG_OP='DELETE' THEN 0 ELSE total_cost_minor END FROM changed_positions
  ON CONFLICT(workspace_id,sku_id,location_id) DO UPDATE SET costed_units=EXCLUDED.costed_units,book_cost_minor=EXCLUDED.book_cost_minor;
  INSERT INTO stockchief_runtime.import_coverage_transactions VALUES(pg_current_xact_id()) ON CONFLICT DO NOTHING;
  RETURN NULL;
 END IF;
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
END $$;
