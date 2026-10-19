-- Maintain the derived SKU count with the exact row delta. Recounting all
-- variants after each insert makes a wide catalogue quadratic. Existing
-- rollups are already canonical; this changes no stock or accounting rows.
CREATE OR REPLACE FUNCTION stockchief_catalog_remove_sku(target_workspace TEXT,target_item TEXT,removed_sku TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE previous_first TEXT; first_row RECORD;
BEGIN
 UPDATE item_catalog_rollups SET sku_count=sku_count-1,
  updated_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 WHERE workspace_id=target_workspace AND item_id=target_item RETURNING first_sku_id INTO previous_first;
 IF previous_first=removed_sku THEN
  SELECT id,code,position INTO first_row FROM skus WHERE workspace_id=target_workspace AND item_id=target_item ORDER BY position,id LIMIT 1;
  UPDATE item_catalog_rollups SET first_sku_id=first_row.id,first_sku_code=first_row.code,first_sku_position=first_row.position
   WHERE workspace_id=target_workspace AND item_id=target_item;
 END IF;
END; $$;

CREATE OR REPLACE FUNCTION stockchief_sku_rollup_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE first_row RECORD;
BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (OLD.item_id IS DISTINCT FROM NEW.item_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id)) THEN
  PERFORM stockchief_catalog_remove_sku(OLD.workspace_id,OLD.item_id,OLD.id);
 END IF;
 IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND (OLD.item_id IS DISTINCT FROM NEW.item_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id)) THEN
  INSERT INTO item_catalog_rollups(workspace_id,item_id,sku_count,first_sku_id,first_sku_code,first_sku_position,updated_at)
   VALUES(NEW.workspace_id,NEW.item_id,1,NEW.id,NEW.code,NEW.position,
    to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   ON CONFLICT(item_id) DO UPDATE SET sku_count=item_catalog_rollups.sku_count+1,
    first_sku_id=CASE WHEN item_catalog_rollups.first_sku_id IS NULL OR (EXCLUDED.first_sku_position,EXCLUDED.first_sku_id)<(item_catalog_rollups.first_sku_position,item_catalog_rollups.first_sku_id) THEN EXCLUDED.first_sku_id ELSE item_catalog_rollups.first_sku_id END,
    first_sku_code=CASE WHEN item_catalog_rollups.first_sku_id IS NULL OR (EXCLUDED.first_sku_position,EXCLUDED.first_sku_id)<(item_catalog_rollups.first_sku_position,item_catalog_rollups.first_sku_id) THEN EXCLUDED.first_sku_code ELSE item_catalog_rollups.first_sku_code END,
    first_sku_position=CASE WHEN item_catalog_rollups.first_sku_id IS NULL OR (EXCLUDED.first_sku_position,EXCLUDED.first_sku_id)<(item_catalog_rollups.first_sku_position,item_catalog_rollups.first_sku_id) THEN EXCLUDED.first_sku_position ELSE item_catalog_rollups.first_sku_position END,
    updated_at=EXCLUDED.updated_at;
 ELSIF TG_OP='UPDATE' THEN
  -- Price/status edits keep the count. The first variant is selected from
  -- canonical rows so changes to ordering or its code remain accurate.
  SELECT id,code,position INTO first_row FROM skus WHERE workspace_id=NEW.workspace_id AND item_id=NEW.item_id ORDER BY position,id LIMIT 1;
  UPDATE item_catalog_rollups SET first_sku_id=first_row.id,first_sku_code=first_row.code,first_sku_position=first_row.position,
   updated_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   WHERE workspace_id=NEW.workspace_id AND item_id=NEW.item_id;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$;
