CREATE TABLE stockchief_runtime.sku_stock_state(
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 initialized boolean NOT NULL DEFAULT false
);
CREATE TABLE stockchief_runtime.sku_stock_totals(
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL,on_hand numeric NOT NULL,
 PRIMARY KEY(workspace_id,sku_id)
);
CREATE TABLE stockchief_runtime.sku_stock_pending(
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL,change_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),quantity_delta numeric NOT NULL,
 PRIMARY KEY(workspace_id,sku_id,change_xid)
);
CREATE INDEX sku_stock_pending_oldest ON stockchief_runtime.sku_stock_pending(workspace_id,change_xid,sku_id);
ALTER TABLE stockchief_runtime.sku_stock_pending SET(autovacuum_vacuum_scale_factor=0.02,autovacuum_vacuum_insert_scale_factor=0.02,autovacuum_analyze_scale_factor=0.02);
CREATE FUNCTION stockchief_queue_sku_stock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO stockchief_runtime.sku_stock_pending(workspace_id,sku_id,quantity_delta)
  SELECT b.workspace_id,b.sku_id,sum(b.on_hand) FROM new_stock b JOIN workspaces w ON w.id=b.workspace_id GROUP BY 1,2 HAVING sum(b.on_hand)<>0
  ON CONFLICT(workspace_id,sku_id,change_xid) DO UPDATE SET quantity_delta=stockchief_runtime.sku_stock_pending.quantity_delta+EXCLUDED.quantity_delta;
 ELSIF TG_OP='DELETE' THEN
  INSERT INTO stockchief_runtime.sku_stock_pending(workspace_id,sku_id,quantity_delta)
  SELECT b.workspace_id,b.sku_id,-sum(b.on_hand) FROM old_stock b JOIN workspaces w ON w.id=b.workspace_id GROUP BY 1,2 HAVING sum(b.on_hand)<>0
  ON CONFLICT(workspace_id,sku_id,change_xid) DO UPDATE SET quantity_delta=stockchief_runtime.sku_stock_pending.quantity_delta+EXCLUDED.quantity_delta;
 ELSE
  INSERT INTO stockchief_runtime.sku_stock_pending(workspace_id,sku_id,quantity_delta)
  SELECT b.workspace_id,b.sku_id,sum(b.quantity_delta) FROM(SELECT workspace_id,sku_id,on_hand quantity_delta FROM new_stock UNION ALL SELECT workspace_id,sku_id,-on_hand FROM old_stock)b
  JOIN workspaces w ON w.id=b.workspace_id GROUP BY 1,2 HAVING sum(b.quantity_delta)<>0
  ON CONFLICT(workspace_id,sku_id,change_xid) DO UPDATE SET quantity_delta=stockchief_runtime.sku_stock_pending.quantity_delta+EXCLUDED.quantity_delta;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER zz_sku_stock_insert AFTER INSERT ON balances REFERENCING NEW TABLE AS new_stock FOR EACH STATEMENT EXECUTE FUNCTION stockchief_queue_sku_stock();
CREATE TRIGGER zz_sku_stock_update AFTER UPDATE ON balances REFERENCING NEW TABLE AS new_stock OLD TABLE AS old_stock FOR EACH STATEMENT EXECUTE FUNCTION stockchief_queue_sku_stock();
CREATE TRIGGER zz_sku_stock_delete AFTER DELETE ON balances REFERENCING OLD TABLE AS old_stock FOR EACH STATEMENT EXECUTE FUNCTION stockchief_queue_sku_stock();
INSERT INTO stockchief_runtime.sku_stock_state(workspace_id) SELECT id FROM workspaces;
