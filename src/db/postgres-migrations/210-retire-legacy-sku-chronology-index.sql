-- Native demand planning reads replenishment_demand_events and its durable
-- cycle snapshot. This older nonunique index is no longer a native read path,
-- but every receipt still maintains its wide workspace/SKU/time keys.
-- Keep the SKU/sequence and workspace/SKU/location/time history indexes.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.idx_movements_workspace_sku_time') AND indisunique)
 THEN RAISE EXCEPTION 'The legacy chronology index unexpectedly enforces uniqueness'; END IF;
END $$;
DROP INDEX IF EXISTS public.idx_movements_workspace_sku_time;
