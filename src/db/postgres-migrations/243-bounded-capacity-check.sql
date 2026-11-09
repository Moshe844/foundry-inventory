-- The plan-limit guard stays synchronous and exact, but adding SKUs no longer
-- joins every SKU in the account to its product on every insert statement.
-- Active SKUs under any product can only be fewer than active SKUs overall,
-- so when that plain count is within the limit the exact count is as well.
-- Only an account that is actually near its limit pays for the exact join.
-- The join recount made each 500-SKU import batch cost O(catalogue), and it
-- turned into a per-row plan whenever statistics lagged behind a big import.
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
 IF lim IS NULL THEN RETURN; END IF;
 IF m<>'products' THEN
  SELECT count(*) INTO used FROM workspaces ws JOIN skus s ON s.workspace_id=ws.id
  WHERE ws.owner_account_id=a AND ws.deletion_requested_at IS NULL AND s.is_active=1;
  IF used<=lim THEN RETURN; END IF;
 END IF;
 SELECT coalesce(sum(CASE WHEN m='products' THEN c.active_products ELSE c.active_skus END),0) INTO used
 FROM stockchief_runtime.inventory_capacity c JOIN workspaces ws ON ws.id=c.workspace_id
 WHERE ws.owner_account_id=a AND ws.deletion_requested_at IS NULL;
 IF used>lim THEN
  RAISE EXCEPTION '% exceed the account plan limit of %. Archive products or upgrade before adding more.',
   CASE WHEN m='products' THEN 'Products' ELSE 'Active SKUs' END,lim
   USING ERRCODE='23514',CONSTRAINT='inventory_plan_capacity';
 END IF;
END $$;
