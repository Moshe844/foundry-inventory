-- Warehouse policies read one location across many variants. Keep the same
-- covering columns, but store each warehouse's positions together instead of
-- probing its entry separately throughout every SKU's bin history.
-- Staging can prepare this index CONCURRENTLY before deploying the migration;
-- retain the previous index until the replacement is valid and fully ready.
SET LOCAL lock_timeout='1000ms';
CREATE INDEX IF NOT EXISTS idx_balances_workspace_location_covering
 ON balances(workspace_id,location_id,sku_id) INCLUDE(on_hand);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index i
  WHERE i.indexrelid=to_regclass('public.idx_balances_workspace_location_covering')
   AND i.indrelid='public.balances'::regclass AND i.indisvalid AND i.indisready
   AND NOT i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
   AND i.indnkeyatts=3 AND i.indnatts=4
   AND pg_get_indexdef(i.indexrelid,1,true)='workspace_id'
   AND pg_get_indexdef(i.indexrelid,2,true)='location_id'
   AND pg_get_indexdef(i.indexrelid,3,true)='sku_id'
   AND pg_get_indexdef(i.indexrelid,4,true)='on_hand') THEN
  RAISE EXCEPTION 'The replacement warehouse stock index is not valid and complete.';
 END IF;
END $$;
DROP INDEX IF EXISTS idx_balances_workspace_covering;
SET LOCAL lock_timeout='120000ms';
