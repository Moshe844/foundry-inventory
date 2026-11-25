-- Plan limits stay exact and synchronous, but admitting new products or SKUs no
-- longer recounts the whole account on every insert statement. That recount cost
-- grew with the catalogue, so a large import's preparing step slowed batch after
-- batch (1,750 to 350 rows a second on a million-row catalogue).
--
-- Each account keeps an upper bound of its active SKUs and of its products:
-- - It is written only by growth, only under the account capacity lock that growth
--   already takes, and in the same transaction, so it rolls back with that growth.
-- - Archiving and deleting never touch it, so it can only be high, never low.
-- - Growth that keeps the bound within the plan is admitted without counting.
-- - Growth that would pass the plan recounts exactly, as before, and resets the bound.
-- - Restoring or moving an inventory, or growth while the plan has no limit, adds
--   records outside these steps, so it discards the bound and the next growth recounts.
-- Ordinary stock writes never touch it. Read-side totals still come from the
-- stockchief_runtime.inventory_capacity view (192); only this check reads the bound.
CREATE TABLE stockchief_runtime.inventory_capacity_bounds(
 account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 meter text NOT NULL CHECK(meter IN ('active_skus','products')),
 upper_bound bigint NOT NULL CHECK(upper_bound>=0),
 PRIMARY KEY(account_id,meter));

CREATE OR REPLACE FUNCTION stockchief_adjust_capacity(w text,delta bigint,m text DEFAULT 'active_skus')
 RETURNS void LANGUAGE plpgsql AS $$
DECLARE a text; lim bigint; used bigint;
BEGIN
 IF delta<=0 THEN RETURN; END IF;
 SELECT owner_account_id INTO a FROM workspaces WHERE id=w;
 IF NOT FOUND THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM workspaces WHERE id=w AND deletion_requested_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Restore this inventory before adding products.' USING ERRCODE='23514',CONSTRAINT='inventory_plan_capacity';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory-capacity:'||a,0));
 lim=stockchief_capacity_limit(w,m);
 IF lim IS NULL THEN
  DELETE FROM stockchief_runtime.inventory_capacity_bounds WHERE account_id=a AND meter=m;
  RETURN;
 END IF;
 UPDATE stockchief_runtime.inventory_capacity_bounds SET upper_bound=upper_bound+delta
  WHERE account_id=a AND meter=m AND upper_bound+delta<=lim;
 IF FOUND THEN RETURN; END IF;
 -- Active SKUs under any product can only be fewer than active SKUs overall (243),
 -- so the plain count is itself a valid bound when it is within the plan.
 IF m<>'products' THEN
  SELECT count(*) INTO used FROM workspaces ws JOIN skus s ON s.workspace_id=ws.id
  WHERE ws.owner_account_id=a AND ws.deletion_requested_at IS NULL AND s.is_active=1;
 END IF;
 IF m='products' OR used>lim THEN
  SELECT coalesce(sum(CASE WHEN m='products' THEN c.active_products ELSE c.active_skus END),0) INTO used
  FROM stockchief_runtime.inventory_capacity c JOIN workspaces ws ON ws.id=c.workspace_id
  WHERE ws.owner_account_id=a AND ws.deletion_requested_at IS NULL;
  IF used>lim THEN
   RAISE EXCEPTION '% exceed the account plan limit of %. Archive products or upgrade before adding more.',
    CASE WHEN m='products' THEN 'Products' ELSE 'Active SKUs' END,lim
    USING ERRCODE='23514',CONSTRAINT='inventory_plan_capacity';
  END IF;
 END IF;
 INSERT INTO stockchief_runtime.inventory_capacity_bounds(account_id,meter,upper_bound) VALUES(a,m,used)
  ON CONFLICT(account_id,meter) DO UPDATE SET upper_bound=EXCLUDED.upper_bound;
END $$;

CREATE OR REPLACE FUNCTION stockchief_workspace_capacity_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lim bigint; used bigint; a text; m text;
BEGIN
 IF NEW.deletion_requested_at IS NOT NULL THEN RETURN NULL; END IF;
 IF OLD.owner_account_id IS NOT DISTINCT FROM NEW.owner_account_id AND OLD.deletion_requested_at IS NULL THEN RETURN NULL; END IF;
 FOR a IN SELECT DISTINCT owner FROM unnest(ARRAY[OLD.owner_account_id,NEW.owner_account_id]) owner ORDER BY owner LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('inventory-capacity:'||a,0));
 END LOOP;
 -- A restored or transferred inventory brings records the bound never saw.
 DELETE FROM stockchief_runtime.inventory_capacity_bounds WHERE account_id IN (OLD.owner_account_id,NEW.owner_account_id);
 FOR m IN SELECT unnest(ARRAY['active_skus','products']) LOOP
 lim=stockchief_capacity_limit(NEW.id,m);
 SELECT COALESCE(sum(CASE WHEN m='products' THEN c.active_products ELSE c.active_skus END),0) INTO used FROM stockchief_runtime.inventory_capacity c
  JOIN workspaces w ON w.id=c.workspace_id WHERE w.owner_account_id=NEW.owner_account_id AND w.deletion_requested_at IS NULL;
 IF lim IS NOT NULL AND used>lim THEN RAISE EXCEPTION 'Restoring or transferring this inventory exceeds the account active SKU limit of %.',lim
  USING ERRCODE='23514',CONSTRAINT='inventory_plan_capacity'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
