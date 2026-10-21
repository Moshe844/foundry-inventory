CREATE TABLE IF NOT EXISTS catalog_source_facts (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 sku_id TEXT NOT NULL REFERENCES skus(id),
 location_id TEXT REFERENCES locations(id),
 name TEXT NOT NULL,
 value TEXT NOT NULL,
 source_import_id TEXT REFERENCES import_plans(id),
 source_row BIGINT,
 updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_source_fact_scope ON catalog_source_facts(workspace_id,sku_id,COALESCE(location_id,''),name,source_import_id,source_row);
-- A single-SKU product has the same evidenced item code as that SKU. Do not
-- invent a parent code for variants or override an existing historical code.
UPDATE items i SET base_code=s.code FROM skus s WHERE s.workspace_id=i.workspace_id AND s.item_id=i.id
 AND i.base_code IS NULL AND i.has_variants=0
 AND NOT EXISTS(SELECT 1 FROM skus other WHERE other.item_id=i.id AND other.id<>s.id)
 AND NOT EXISTS(SELECT 1 FROM skus other WHERE other.workspace_id=i.workspace_id AND other.item_id<>i.id AND lower(other.code)=lower(s.code))
 AND NOT EXISTS(SELECT 1 FROM items other WHERE other.workspace_id=i.workspace_id AND other.base_code=s.code AND other.id<>i.id);
