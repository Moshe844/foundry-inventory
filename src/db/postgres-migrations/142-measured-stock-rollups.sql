ALTER TABLE item_location_balances ADD COLUMN secondary_on_hand numeric;
UPDATE item_location_balances target SET secondary_on_hand=source.weight
 FROM(SELECT b.workspace_id,s.item_id,b.location_id,sum(b.secondary_on_hand) AS weight FROM balances b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id WHERE b.secondary_on_hand IS NOT NULL GROUP BY b.workspace_id,s.item_id,b.location_id) source
 WHERE target.workspace_id=source.workspace_id AND target.item_id=source.item_id AND target.location_id=source.location_id;
CREATE FUNCTION stockchief_secondary_rollup_delta() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_item text; delta numeric; target_workspace text; target_sku text; target_location text; changed_at text;
BEGIN
 IF TG_OP='DELETE' THEN target_workspace:=OLD.workspace_id;target_sku:=OLD.sku_id;target_location:=OLD.location_id;delta:=-coalesce(OLD.secondary_on_hand,0);changed_at:=OLD.updated_at;
 ELSE target_workspace:=NEW.workspace_id;target_sku:=NEW.sku_id;target_location:=NEW.location_id;delta:=coalesce(NEW.secondary_on_hand,0)-CASE WHEN TG_OP='UPDATE' THEN coalesce(OLD.secondary_on_hand,0) ELSE 0 END;changed_at:=NEW.updated_at;END IF;
 IF delta=0 THEN RETURN NULL;END IF;
 SELECT item_id INTO target_item FROM skus WHERE workspace_id=target_workspace AND id=target_sku;
 IF target_item IS NULL THEN RETURN NULL;END IF;
 INSERT INTO item_location_balances(workspace_id,item_id,location_id,on_hand,secondary_on_hand,updated_at) VALUES(target_workspace,target_item,target_location,0,delta,changed_at)
 ON CONFLICT(item_id,location_id) DO UPDATE SET secondary_on_hand=coalesce(item_location_balances.secondary_on_hand,0)+EXCLUDED.secondary_on_hand,updated_at=EXCLUDED.updated_at;
 RETURN NULL;
END; $$;
CREATE TRIGGER secondary_balances_rollup AFTER INSERT OR UPDATE OR DELETE ON balances FOR EACH ROW EXECUTE FUNCTION stockchief_secondary_rollup_delta();
