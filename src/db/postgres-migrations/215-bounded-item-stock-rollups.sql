-- A transition batch must probe only its SKU keys. A flattened join can scan
-- the catalogue of every tenant once for each import batch. Retain the exact
-- aggregate delta and atomic upsert; bound only the metadata lookup.
-- Keep indexed join planning local to this bounded delta function. PostgreSQL
-- restores the caller's planner settings after the trigger returns.
CREATE OR REPLACE FUNCTION stockchief_batch_item_stock_rollup() RETURNS trigger LANGUAGE plpgsql
 SET enable_hashjoin='off' SET enable_mergejoin='off' AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  UPDATE item_location_balances target
  SET on_hand=target.on_hand-source.quantity,
   secondary_on_hand=CASE WHEN source.weight IS NULL THEN target.secondary_on_hand ELSE coalesce(target.secondary_on_hand,0)-source.weight END,
   updated_at=source.changed_at
  FROM(SELECT n.workspace_id,s.item_id,n.location_id,sum(n.on_hand) quantity,sum(n.secondary_on_hand) weight,max(n.updated_at) changed_at
   FROM old_stock n JOIN LATERAL(SELECT s.item_id FROM skus s WHERE s.workspace_id=n.workspace_id AND s.id=n.sku_id OFFSET 0)s ON true
   GROUP BY n.workspace_id,s.item_id,n.location_id) source
  WHERE target.workspace_id=source.workspace_id AND target.item_id=source.item_id AND target.location_id=source.location_id;
 ELSIF TG_OP='INSERT' THEN
  INSERT INTO item_location_balances AS target(workspace_id,item_id,location_id,on_hand,secondary_on_hand,updated_at)
  SELECT n.workspace_id,s.item_id,n.location_id,sum(n.on_hand),sum(n.secondary_on_hand),max(n.updated_at)
  FROM new_stock n JOIN LATERAL(SELECT s.item_id FROM skus s WHERE s.workspace_id=n.workspace_id AND s.id=n.sku_id OFFSET 0)s ON true
  GROUP BY n.workspace_id,s.item_id,n.location_id ORDER BY n.workspace_id,s.item_id,n.location_id
  ON CONFLICT(item_id,location_id) DO UPDATE SET on_hand=target.on_hand+EXCLUDED.on_hand,
   secondary_on_hand=CASE WHEN EXCLUDED.secondary_on_hand IS NULL THEN target.secondary_on_hand ELSE coalesce(target.secondary_on_hand,0)+EXCLUDED.secondary_on_hand END,
   updated_at=EXCLUDED.updated_at;
 ELSE
  INSERT INTO item_location_balances AS target(workspace_id,item_id,location_id,on_hand,secondary_on_hand,updated_at)
  SELECT n.workspace_id,s.item_id,n.location_id,sum(n.quantity),sum(n.weight),coalesce(max(n.changed_at),(SELECT max(updated_at) FROM new_stock))
  FROM(SELECT workspace_id,sku_id,location_id,on_hand quantity,secondary_on_hand weight,updated_at changed_at FROM new_stock
   UNION ALL SELECT workspace_id,sku_id,location_id,-on_hand,-secondary_on_hand,NULL::text FROM old_stock)n
  JOIN LATERAL(SELECT s.item_id FROM skus s WHERE s.workspace_id=n.workspace_id AND s.id=n.sku_id OFFSET 0)s ON true
  GROUP BY n.workspace_id,s.item_id,n.location_id ORDER BY n.workspace_id,s.item_id,n.location_id
  ON CONFLICT(item_id,location_id) DO UPDATE SET on_hand=target.on_hand+EXCLUDED.on_hand,
   secondary_on_hand=CASE WHEN EXCLUDED.secondary_on_hand IS NULL THEN target.secondary_on_hand ELSE coalesce(target.secondary_on_hand,0)+EXCLUDED.secondary_on_hand END,
   updated_at=EXCLUDED.updated_at;
 END IF;
 RETURN NULL;
END;
$$;
