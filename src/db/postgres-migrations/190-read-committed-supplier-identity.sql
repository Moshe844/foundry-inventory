-- Preserve historical ambiguous names; new find-or-create operations have a
-- database-owned, case-insensitive identity instead of relying on isolation.
ALTER TABLE suppliers ADD COLUMN canonical_name TEXT;
WITH names AS(SELECT workspace_id,lower(btrim(name)) AS name,count(*) AS n FROM suppliers GROUP BY workspace_id,lower(btrim(name)))
UPDATE suppliers s SET canonical_name=n.name FROM names n
 WHERE n.workspace_id=s.workspace_id AND n.name=lower(btrim(s.name)) AND n.n=1;
CREATE UNIQUE INDEX suppliers_canonical_identity ON suppliers(workspace_id,canonical_name) WHERE canonical_name IS NOT NULL;
CREATE FUNCTION stockchief_supplier_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity_name text := lower(btrim(NEW.name));
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.canonical_name IS NULL AND lower(btrim(OLD.name))=identity_name THEN NEW.canonical_name=NULL; RETURN NEW; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM suppliers s WHERE s.workspace_id=NEW.workspace_id AND s.canonical_name IS NULL
  AND lower(btrim(s.name))=identity_name AND s.id<>NEW.id) THEN
  RAISE EXCEPTION 'More than one historical supplier uses this name. Choose or rename the existing suppliers before importing.'
   USING ERRCODE='23514',CONSTRAINT='supplier_name_ambiguous';
 END IF;
 NEW.canonical_name=identity_name;RETURN NEW;
END $$;
CREATE TRIGGER supplier_identity BEFORE INSERT OR UPDATE OF name,canonical_name ON suppliers FOR EACH ROW EXECUTE FUNCTION stockchief_supplier_identity();
