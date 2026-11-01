WITH changed AS (
 UPDATE items SET base_code='PRODUCT-'||upper(id),updated_at=now()::text
 WHERE has_variants=1 AND (base_code IS NULL OR trim(base_code)='')
 RETURNING id,workspace_id,base_code
)
INSERT INTO catalogue_change_history(id,workspace_id,item_id,action,before_state,after_state)
SELECT 'variant-parent-code:'||id,workspace_id,id,'assign_parent_code',jsonb_build_object('code',NULL),jsonb_build_object('code',base_code,'basis','Generated stable parent product identifier') FROM changed;
