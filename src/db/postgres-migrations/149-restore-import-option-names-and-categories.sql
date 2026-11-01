-- Older imports retained these literal source facts but used spreadsheet column
-- headings as option names. Restore only facts unambiguous across the item.
WITH source_names AS (
 SELECT s.workspace_id,s.item_id,o.id AS option_id,min(f.value) AS name
 FROM item_options o JOIN skus s ON s.workspace_id=o.workspace_id AND s.item_id=o.item_id
 JOIN catalog_source_facts source ON source.workspace_id=s.workspace_id AND source.sku_id=s.id
 CROSS JOIN LATERAL jsonb_each_text(CASE WHEN source.attributes IS NULL THEN jsonb_build_object(source.name,source.value) ELSE source.attributes END) f
 WHERE o.name ~* '^option[ _-]*[123][ _-]*value$'
 AND regexp_replace(lower(f.key),'[^a-z0-9]','','g')='option'||(o.position+1)::text||'name'
 AND length(trim(f.value)) BETWEEN 1 AND 120
 GROUP BY s.workspace_id,s.item_id,o.id HAVING count(DISTINCT f.value)=1
), changed AS (
 UPDATE item_options o SET name=trim(source.name) FROM source_names source
 WHERE o.workspace_id=source.workspace_id AND o.id=source.option_id
 AND NOT EXISTS(SELECT 1 FROM source_names duplicate WHERE duplicate.workspace_id=source.workspace_id AND duplicate.item_id=source.item_id AND duplicate.option_id<>source.option_id AND lower(trim(duplicate.name))=lower(trim(source.name)))
 AND NOT EXISTS(SELECT 1 FROM item_options other WHERE other.workspace_id=o.workspace_id AND other.item_id=o.item_id AND other.id<>o.id AND lower(other.name)=lower(trim(source.name)))
 RETURNING o.workspace_id,o.item_id,o.id,o.name,o.position
)
INSERT INTO catalogue_change_history(id,workspace_id,item_id,action,before_state,after_state)
SELECT 'normalize-option:'||id,workspace_id,item_id,'restore_import_option_name',
jsonb_build_object('name','Option '||(position+1)::text||' value'),jsonb_build_object('name',name,'basis','Recorded source option-name column') FROM changed;

WITH source_categories AS (
 SELECT s.workspace_id,s.item_id,min(trim(f.value)) AS category
 FROM skus s JOIN catalog_source_facts source ON source.workspace_id=s.workspace_id AND source.sku_id=s.id
 CROSS JOIN LATERAL jsonb_each_text(CASE WHEN source.attributes IS NULL THEN jsonb_build_object(source.name,source.value) ELSE source.attributes END) f
 WHERE regexp_replace(lower(f.key),'[^a-z0-9]','','g')='category' AND length(trim(f.value)) BETWEEN 1 AND 240
 GROUP BY s.workspace_id,s.item_id HAVING count(DISTINCT trim(f.value))=1
), changed AS (
 INSERT INTO catalogue_item_facts(workspace_id,item_id,category,facts,created_at,updated_at)
 SELECT workspace_id,item_id,category,'{}',now()::text,now()::text FROM source_categories
 ON CONFLICT(workspace_id,item_id) DO UPDATE SET category=excluded.category,updated_at=excluded.updated_at
 WHERE catalogue_item_facts.category IS NULL OR trim(catalogue_item_facts.category)=''
 RETURNING workspace_id,item_id,category
)
INSERT INTO catalogue_change_history(id,workspace_id,item_id,action,before_state,after_state)
SELECT 'normalize-category:'||item_id,workspace_id,item_id,'restore_import_category','{}',jsonb_build_object('category',category,'basis','Recorded source category column') FROM changed;
