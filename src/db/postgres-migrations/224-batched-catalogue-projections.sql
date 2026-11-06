-- Update search projections once per source statement. The source rows and
-- their history remain canonical; only derived search/variant metadata changes.
CREATE FUNCTION stockchief_search_items_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM search_documents d USING old_items n WHERE d.workspace_id=n.workspace_id
   AND ((d.entity_type='item' AND d.entity_id=n.id) OR (d.entity_type='sku' AND EXISTS(
    SELECT 1 FROM skus s WHERE s.workspace_id=n.workspace_id AND s.item_id=n.id AND s.id=d.entity_id)));
 ELSE
  INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
  SELECT n.workspace_id,'item',n.id,n.name,coalesce(n.base_code,''),coalesce(n.description,'')||' '||coalesce(n.unit_label,''),n.updated_at
  FROM new_items n ORDER BY n.workspace_id,n.id
  ON CONFLICT(workspace_id,entity_type,entity_id) DO UPDATE SET title=EXCLUDED.title,
   identifiers=EXCLUDED.identifiers,body=EXCLUDED.body,updated_at=EXCLUDED.updated_at;
  IF TG_OP='UPDATE' THEN
   UPDATE search_documents d SET title=n.name||' '||coalesce(s.variant_label,''),body=coalesce(n.description,''),updated_at=n.updated_at
   FROM new_items n JOIN skus s ON s.workspace_id=n.workspace_id AND s.item_id=n.id
   WHERE d.workspace_id=n.workspace_id AND d.entity_type='sku' AND d.entity_id=s.id;
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION stockchief_search_skus_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM search_documents d USING old_skus n
  WHERE d.workspace_id=n.workspace_id AND d.entity_type='sku' AND d.entity_id=n.id;
 ELSE
  IF TG_OP='UPDATE' THEN
   DELETE FROM search_documents d USING old_skus o JOIN new_skus n ON n.id=o.id
   WHERE o.workspace_id<>n.workspace_id AND d.workspace_id=o.workspace_id AND d.entity_type='sku' AND d.entity_id=o.id;
  END IF;
  INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
  SELECT n.workspace_id,'sku',n.id,i.name||' '||coalesce(n.variant_label,''),
   n.code||' '||coalesce(n.barcode,''),coalesce(i.description,''),n.created_at
  FROM new_skus n JOIN items i ON i.workspace_id=n.workspace_id AND i.id=n.item_id ORDER BY n.workspace_id,n.id
  ON CONFLICT(workspace_id,entity_type,entity_id) DO UPDATE SET title=EXCLUDED.title,
   identifiers=EXCLUDED.identifiers,body=EXCLUDED.body,updated_at=EXCLUDED.updated_at;
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION stockchief_search_supplier_items_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM search_documents d USING old_supplier_items n
  WHERE d.workspace_id=n.workspace_id AND d.entity_type='supplier_item' AND d.entity_id=n.id;
 ELSE
  INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
  SELECT n.workspace_id,'supplier_item',n.id,coalesce(n.supplier_description,i.name),
   coalesce(n.supplier_sku,''),sp.name||' '||s.code||' '||i.name,n.updated_at
  FROM new_supplier_items n JOIN suppliers sp ON sp.workspace_id=n.workspace_id AND sp.id=n.supplier_id
  JOIN skus s ON s.workspace_id=n.workspace_id AND s.id=n.sku_id
  JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id ORDER BY n.workspace_id,n.id
  ON CONFLICT(workspace_id,entity_type,entity_id) DO UPDATE SET title=EXCLUDED.title,
   identifiers=EXCLUDED.identifiers,body=EXCLUDED.body,updated_at=EXCLUDED.updated_at;
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION stockchief_sku_rollup_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  SELECT jsonb_agg(to_jsonb(d)) INTO affected FROM(
   SELECT workspace_id,item_id,count(*)::bigint delta FROM new_skus GROUP BY workspace_id,item_id)d;
 ELSIF TG_OP='DELETE' THEN
  SELECT jsonb_agg(to_jsonb(d)) INTO affected FROM(
   SELECT workspace_id,item_id,-count(*)::bigint delta FROM old_skus GROUP BY workspace_id,item_id)d;
 ELSE
  SELECT jsonb_agg(to_jsonb(d)) INTO affected FROM(
   SELECT workspace_id,item_id,sum(delta)::bigint delta FROM(
    SELECT workspace_id,item_id,1 delta FROM new_skus UNION ALL
    SELECT workspace_id,item_id,-1 delta FROM old_skus) changes GROUP BY workspace_id,item_id)d;
 END IF;
 IF affected IS NULL THEN RETURN NULL; END IF;
 -- Repair a missing projection from its canonical pre-statement population.
 -- Normal item creation already installed the zero-count parent projection.
 INSERT INTO item_catalog_rollups(workspace_id,item_id,sku_count,updated_at)
 SELECT d.workspace_id,d.item_id,(SELECT count(*) FROM skus s WHERE s.workspace_id=d.workspace_id AND s.item_id=d.item_id)-d.delta,
  to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 FROM jsonb_to_recordset(affected)d(workspace_id text,item_id text,delta bigint)
 JOIN items i ON i.workspace_id=d.workspace_id AND i.id=d.item_id
 WHERE NOT EXISTS(SELECT 1 FROM item_catalog_rollups r WHERE r.workspace_id=d.workspace_id AND r.item_id=d.item_id)
 ORDER BY d.workspace_id,d.item_id ON CONFLICT(item_id) DO NOTHING;
 -- Serialize only the affected parent summaries. Counts use atomic deltas;
 -- a concurrent writer cannot overwrite another transaction's inserted SKUs.
 PERFORM r.item_id FROM item_catalog_rollups r
 JOIN jsonb_to_recordset(affected)d(workspace_id text,item_id text,delta bigint)
  ON r.workspace_id=d.workspace_id AND r.item_id=d.item_id
 ORDER BY r.workspace_id,r.item_id FOR UPDATE OF r;
 UPDATE item_catalog_rollups r SET sku_count=r.sku_count+d.delta,
  updated_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 FROM jsonb_to_recordset(affected)d(workspace_id text,item_id text,delta bigint)
 WHERE r.workspace_id=d.workspace_id AND r.item_id=d.item_id;
 UPDATE item_catalog_rollups r SET first_sku_id=s.id,first_sku_code=s.code,first_sku_position=s.position
 FROM jsonb_to_recordset(affected)d(workspace_id text,item_id text,delta bigint)
 LEFT JOIN LATERAL(SELECT id,code,position FROM skus s WHERE s.workspace_id=d.workspace_id AND s.item_id=d.item_id
  ORDER BY position,id LIMIT 1)s ON true
 WHERE r.workspace_id=d.workspace_id AND r.item_id=d.item_id;
 RETURN NULL;
END $$;
DO $$
DECLARE r record; event text; reference text;
BEGIN
 FOR r IN SELECT * FROM(VALUES
  ('items','stockchief_search_items','stockchief_search_items_batch','new_items','old_items'),
  ('skus','stockchief_search_skus','stockchief_search_skus_batch','new_skus','old_skus'),
  ('supplier_items','stockchief_search_supplier_items','stockchief_search_supplier_items_batch','new_supplier_items','old_supplier_items'),
  ('skus','stockchief_sku_rollup','stockchief_sku_rollup_batch','new_skus','old_skus')
 ) f(relation,old_trigger,function_name,new_rows,old_rows)
 LOOP
  EXECUTE format('DROP TRIGGER %I ON %I',r.old_trigger,r.relation);
  FOREACH event IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
   reference:=CASE event WHEN 'INSERT' THEN format('NEW TABLE AS %I',r.new_rows)
    WHEN 'DELETE' THEN format('OLD TABLE AS %I',r.old_rows)
    ELSE format('NEW TABLE AS %I OLD TABLE AS %I',r.new_rows,r.old_rows) END;
   EXECUTE format('CREATE TRIGGER %I AFTER %s ON %I REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION %I()',
    r.old_trigger||'_'||lower(event),event,r.relation,reference,r.function_name);
  END LOOP;
 END LOOP;
END $$;
