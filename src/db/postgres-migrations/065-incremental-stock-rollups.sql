-- Derived item/location totals follow the exact committed balance delta.
-- Re-aggregating every variant on every stock write makes large imports
-- quadratic and repeats the same work twice for an ordinary UPDATE.
LOCK TABLE skus, balances IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION stockchief_adjust_item_location(
 target_workspace TEXT,target_sku TEXT,target_location TEXT,delta BIGINT,changed_at TEXT
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE target_item TEXT;
BEGIN
 SELECT item_id INTO target_item FROM skus WHERE workspace_id=target_workspace AND id=target_sku;
 IF target_item IS NULL THEN RETURN; END IF;
 INSERT INTO item_location_balances(workspace_id,item_id,location_id,on_hand,updated_at)
 VALUES(target_workspace,target_item,target_location,delta,changed_at)
 ON CONFLICT(item_id,location_id) DO UPDATE
 SET on_hand=item_location_balances.on_hand+EXCLUDED.on_hand,updated_at=EXCLUDED.updated_at;
END;
$$;

CREATE OR REPLACE FUNCTION stockchief_balance_rollup_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.workspace_id=NEW.workspace_id
   AND OLD.sku_id=NEW.sku_id AND OLD.location_id=NEW.location_id THEN
  PERFORM stockchief_adjust_item_location(NEW.workspace_id,NEW.sku_id,NEW.location_id,NEW.on_hand-OLD.on_hand,NEW.updated_at);
 ELSE
  IF TG_OP<>'INSERT' THEN
   UPDATE item_location_balances SET on_hand=on_hand-OLD.on_hand,
    updated_at=CASE WHEN TG_OP='DELETE' THEN OLD.updated_at ELSE NEW.updated_at END
   WHERE workspace_id=OLD.workspace_id AND location_id=OLD.location_id
    AND item_id=(SELECT item_id FROM skus WHERE workspace_id=OLD.workspace_id AND id=OLD.sku_id);
  END IF;
  IF TG_OP<>'DELETE' THEN
   PERFORM stockchief_adjust_item_location(NEW.workspace_id,NEW.sku_id,NEW.location_id,NEW.on_hand,NEW.updated_at);
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END;
$$;

-- Repair the derived cache from its canonical source once under write locks.
DELETE FROM item_location_balances;
INSERT INTO item_location_balances(workspace_id,item_id,location_id,on_hand,updated_at)
 SELECT balance.workspace_id,sku.item_id,balance.location_id,SUM(balance.on_hand),MAX(balance.updated_at)
 FROM balances balance JOIN skus sku ON sku.workspace_id=balance.workspace_id AND sku.id=balance.sku_id
 GROUP BY balance.workspace_id,sku.item_id,balance.location_id;
