CREATE OR REPLACE FUNCTION stockchief_search_supplier_item_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM search_documents
    WHERE workspace_id=OLD.workspace_id AND entity_type='supplier_item' AND entity_id=OLD.id;
    RETURN OLD;
  END IF;
  INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
  SELECT NEW.workspace_id,'supplier_item',NEW.id,COALESCE(NEW.supplier_description,i.name),
    COALESCE(NEW.supplier_sku,''),sp.name || ' ' || s.code || ' ' || i.name,NEW.updated_at
  FROM suppliers sp JOIN skus s ON s.id=NEW.sku_id JOIN items i ON i.id=s.item_id
  WHERE sp.id=NEW.supplier_id
  ON CONFLICT(workspace_id,entity_type,entity_id) DO UPDATE SET title=EXCLUDED.title,
    identifiers=EXCLUDED.identifiers,body=EXCLUDED.body,updated_at=EXCLUDED.updated_at;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS stockchief_search_supplier_items ON supplier_items;
CREATE TRIGGER stockchief_search_supplier_items AFTER INSERT OR UPDATE OR DELETE ON supplier_items
  FOR EACH ROW EXECUTE FUNCTION stockchief_search_supplier_item_trigger();

CREATE OR REPLACE FUNCTION stockchief_search_attribute_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM search_documents
    WHERE workspace_id=OLD.workspace_id AND entity_type='attribute' AND entity_id=OLD.id;
    RETURN OLD;
  END IF;
  INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
  VALUES (NEW.workspace_id,'attribute',NEW.id,NEW.attribute_value,NEW.attribute_key,
    NEW.subject_type || ' ' || NEW.subject_id,NEW.updated_at)
  ON CONFLICT(workspace_id,entity_type,entity_id) DO UPDATE SET title=EXCLUDED.title,
    identifiers=EXCLUDED.identifiers,body=EXCLUDED.body,updated_at=EXCLUDED.updated_at;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS stockchief_search_attributes ON catalog_attributes;
CREATE TRIGGER stockchief_search_attributes AFTER INSERT OR UPDATE OR DELETE ON catalog_attributes
  FOR EACH ROW EXECUTE FUNCTION stockchief_search_attribute_trigger();

INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
SELECT si.workspace_id,'supplier_item',si.id,COALESCE(si.supplier_description,i.name),COALESCE(si.supplier_sku,''),
  sp.name || ' ' || s.code || ' ' || i.name,si.updated_at
FROM supplier_items si JOIN suppliers sp ON sp.id=si.supplier_id
JOIN skus s ON s.id=si.sku_id JOIN items i ON i.id=s.item_id
ON CONFLICT(workspace_id,entity_type,entity_id) DO UPDATE SET title=EXCLUDED.title,
  identifiers=EXCLUDED.identifiers,body=EXCLUDED.body,updated_at=EXCLUDED.updated_at;

INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
SELECT workspace_id,'attribute',id,attribute_value,attribute_key,subject_type || ' ' || subject_id,updated_at
FROM catalog_attributes
ON CONFLICT(workspace_id,entity_type,entity_id) DO UPDATE SET title=EXCLUDED.title,
  identifiers=EXCLUDED.identifiers,body=EXCLUDED.body,updated_at=EXCLUDED.updated_at;
