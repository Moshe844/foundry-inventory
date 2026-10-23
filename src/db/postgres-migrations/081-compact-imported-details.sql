ALTER TABLE catalog_source_facts ADD COLUMN IF NOT EXISTS attributes JSONB;
ALTER TABLE catalog_source_facts ALTER COLUMN name DROP NOT NULL;
ALTER TABLE catalog_source_facts ALTER COLUMN value DROP NOT NULL;
ALTER TABLE catalog_source_facts ADD CONSTRAINT catalog_source_fact_representation CHECK (
 (attributes IS NULL AND name IS NOT NULL AND value IS NOT NULL)
 OR (attributes IS NOT NULL AND jsonb_typeof(attributes)='object' AND attributes<>'{}'::jsonb
     AND name IS NULL AND value IS NULL AND source_import_id IS NOT NULL AND source_row IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_source_document_scope
 ON catalog_source_facts(workspace_id,sku_id,COALESCE(location_id,''),source_import_id,source_row)
 WHERE attributes IS NOT NULL;
CREATE INDEX IF NOT EXISTS catalog_source_fact_import ON catalog_source_facts(workspace_id,source_import_id);
COMMENT ON COLUMN catalog_source_facts.attributes IS
 'Imported field names and exact text values for one SKU/location/source row. Legacy rows use name/value when attributes is null.';
