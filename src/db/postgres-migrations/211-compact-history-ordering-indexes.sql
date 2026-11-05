-- Keep the searchable tenant/SKU/location/time prefixes. The unique record
-- id remains on each row and in its existing primary/unique index; ORDER BY
-- can sort equal timestamps without copying that id into every history key.
-- Equal cost-receipt timestamps can then share btree posting lists too.
DO $$
DECLARE target record; actual text; is_unique boolean;
BEGIN
 FOR target IN SELECT * FROM (VALUES
  ('idx_accounting_cost_movements_sku','accounting_inventory_cost_movements',
   'workspace_id, sku_id, created_at, id','workspace_id, sku_id, created_at'),
  ('idx_movements_workspace_sku_location_time','movements',
   'workspace_id, sku_id, location_id, occurred_at DESC, id','workspace_id, sku_id, location_id, occurred_at DESC')
 ) AS specs(index_name,table_name,old_columns,new_columns)
 LOOP
  SELECT pg_get_indexdef(i.indexrelid),i.indisunique INTO actual,is_unique
   FROM pg_index i WHERE i.indexrelid=to_regclass('public.'||target.index_name);
  IF is_unique THEN RAISE EXCEPTION 'History ordering index unexpectedly enforces uniqueness'; END IF;
  IF actual='CREATE INDEX '||target.index_name||' ON public.'||target.table_name||' USING btree ('||target.new_columns||')' THEN CONTINUE; END IF;
  IF actual IS NOT NULL AND actual<>'CREATE INDEX '||target.index_name||' ON public.'||target.table_name||' USING btree ('||target.old_columns||')'
   THEN RAISE EXCEPTION 'History ordering index has an unexpected definition'; END IF;
  IF actual IS NOT NULL THEN EXECUTE format('DROP INDEX public.%I',target.index_name); END IF;
  EXECUTE format('CREATE INDEX %I ON public.%I (%s)',target.index_name,target.table_name,target.new_columns);
 END LOOP;
END $$;
