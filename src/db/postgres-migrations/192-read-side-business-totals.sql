-- These are rebuildable projections, not source records. Aggregate at the
-- read boundary (and use the versioned cache) instead of locking one shared
-- totals row during every independent receipt, sale or import batch.
DROP TRIGGER cost_coverage_insert ON inventory_cost_coverage_positions;
DROP TRIGGER cost_coverage_update ON inventory_cost_coverage_positions;
DROP TRIGGER daily_journal_totals ON accounting_journal_lines;
DROP TRIGGER movement_second_totals ON movements;
CREATE TRIGGER read_model_insert AFTER INSERT ON movements
 REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();

DELETE FROM commercial_storage_usage WHERE relation=ANY(ARRAY[
 'inventory_cost_coverage_totals'::regclass,'accounting_daily_account_totals'::regclass,
 'inventory_movement_second_totals'::regclass,'stockchief_runtime.inventory_capacity'::regclass]);
DELETE FROM commercial_storage_tables WHERE relation=ANY(ARRAY[
 'inventory_cost_coverage_totals'::regclass,'accounting_daily_account_totals'::regclass,
 'inventory_movement_second_totals'::regclass,'stockchief_runtime.inventory_capacity'::regclass]);

DROP TABLE inventory_cost_coverage_totals;
CREATE VIEW inventory_cost_coverage_totals WITH(security_invoker=true) AS
 SELECT workspace_id,sum(physical_units) AS physical_units,sum(costed_units) AS costed_units,
 sum(book_cost_minor) AS book_cost_minor,sum(missing_units) AS missing_units
 FROM inventory_cost_coverage_positions GROUP BY workspace_id;

DROP TABLE accounting_daily_account_totals;
CREATE VIEW accounting_daily_account_totals WITH(security_invoker=true) AS
 SELECT l.workspace_id,l.account_id,e.posting_date,l.currency,
 sum(l.debit_minor) AS debit_minor,sum(l.credit_minor) AS credit_minor,count(*) AS line_count
 FROM accounting_journal_lines l JOIN accounting_journal_entries e
 ON e.workspace_id=l.workspace_id AND e.id=l.entry_id WHERE e.status='POSTED'
 GROUP BY l.workspace_id,l.account_id,e.posting_date,l.currency;

DROP TABLE inventory_movement_second_totals;
CREATE VIEW inventory_movement_second_totals WITH(security_invoker=true) AS
 SELECT workspace_id,date_trunc('second',occurred_at::timestamptz,'UTC') AS occurred_second,
 sum(quantity_delta) AS quantity_delta,count(*) AS movement_count
 FROM movements GROUP BY workspace_id,date_trunc('second',occurred_at::timestamptz,'UTC');

DROP TABLE stockchief_runtime.inventory_capacity;
CREATE VIEW stockchief_runtime.inventory_capacity WITH(security_invoker=true) AS
 SELECT w.id AS workspace_id,
 (SELECT count(*) FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  WHERE s.workspace_id=w.id AND s.is_active=1 AND i.is_active=1) AS active_skus,
 (SELECT count(*) FROM items i WHERE i.workspace_id=w.id AND i.is_active=1) AS active_products
 FROM workspaces w;

-- The entitlement guard remains synchronous. Only catalogue growth takes
-- this account lock; ordinary stock writes never update a capacity counter.
-- At READ COMMITTED the fresh count after the lock includes prior commits
-- from every inventory owned by the account, as well as this transaction.
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
 SELECT coalesce(sum(CASE WHEN m='products' THEN c.active_products ELSE c.active_skus END),0) INTO used
 FROM stockchief_runtime.inventory_capacity c JOIN workspaces ws ON ws.id=c.workspace_id
 WHERE ws.owner_account_id=a AND ws.deletion_requested_at IS NULL;
 IF lim IS NOT NULL AND used>lim THEN
  RAISE EXCEPTION '% exceed the account plan limit of %. Archive products or upgrade before adding more.',
   CASE WHEN m='products' THEN 'Products' ELSE 'Active SKUs' END,lim
   USING ERRCODE='23514',CONSTRAINT='inventory_plan_capacity';
 END IF;
END $$;
