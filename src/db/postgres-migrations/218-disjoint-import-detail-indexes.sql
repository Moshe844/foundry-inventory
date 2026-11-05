-- Document rows have a NULL legacy field name and their own exact unique
-- index. Keeping them in the legacy index adds write I/O without enforcing
-- another invariant. Retain the original keys for every legacy field row.
DO $$
DECLARE definition text; predicate text; is_unique boolean;
BEGIN
 SELECT pg_get_indexdef(i.indexrelid),pg_get_expr(i.indpred,i.indrelid),i.indisunique
 INTO definition,predicate,is_unique FROM pg_index i
 WHERE i.indexrelid=to_regclass('public.catalog_source_fact_scope')
 AND i.indrelid='public.catalog_source_facts'::regclass;
 IF predicate='(attributes IS NULL)' AND is_unique THEN RETURN; END IF;
 IF NOT coalesce(is_unique,false) OR predicate IS NOT NULL OR definition<>
  'CREATE UNIQUE INDEX catalog_source_fact_scope ON public.catalog_source_facts USING btree (workspace_id, sku_id, COALESCE(location_id, ''''::text), name, source_import_id, source_row)'
 THEN RAISE EXCEPTION 'The legacy imported-detail uniqueness index has an unexpected definition'; END IF;
 DROP INDEX public.catalog_source_fact_scope;
 CREATE UNIQUE INDEX catalog_source_fact_scope ON public.catalog_source_facts
  (workspace_id,sku_id,COALESCE(location_id,''),name,source_import_id,source_row)
  WHERE attributes IS NULL;
END $$;
