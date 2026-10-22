-- A newly inserted product cannot have existing FK-bound variants. Updating
-- every SKU search document after each product INSERT made bulk imports
-- quadratic even though their canonical catalogue writes were batched.
CREATE INDEX IF NOT EXISTS ix_skus_workspace_item_search ON skus(workspace_id,item_id,id);
CREATE INDEX IF NOT EXISTS ix_skus_workspace_normalized_code ON skus(workspace_id,lower(btrim(code)));
CREATE OR REPLACE FUNCTION stockchief_search_item_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM search_documents WHERE workspace_id=OLD.workspace_id AND
   ((entity_type='item' AND entity_id=OLD.id) OR (entity_type='sku' AND entity_id IN
    (SELECT id FROM skus WHERE workspace_id=OLD.workspace_id AND item_id=OLD.id)));
  RETURN OLD;
 END IF;
 INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
 VALUES(NEW.workspace_id,'item',NEW.id,NEW.name,COALESCE(NEW.base_code,''),COALESCE(NEW.description,'') || ' ' || COALESCE(NEW.unit_label,''),NEW.updated_at)
 ON CONFLICT(workspace_id,entity_type,entity_id) DO UPDATE SET title=EXCLUDED.title,identifiers=EXCLUDED.identifiers,body=EXCLUDED.body,updated_at=EXCLUDED.updated_at;
 IF TG_OP='UPDATE' THEN
  UPDATE search_documents d SET title=NEW.name || ' ' || COALESCE(s.variant_label,''),
   body=COALESCE(NEW.description,''),updated_at=NEW.updated_at FROM skus s
   WHERE d.workspace_id=NEW.workspace_id AND s.workspace_id=NEW.workspace_id
    AND d.entity_type='sku' AND d.entity_id=s.id AND s.item_id=NEW.id;
 END IF;
 RETURN NEW;
END; $$;
