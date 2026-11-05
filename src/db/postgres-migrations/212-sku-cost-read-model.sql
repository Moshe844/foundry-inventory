-- Rebuildable per-SKU summaries. Canonical receipts, balances and journals
-- remain authoritative. Writers append independent refresh requests; they
-- never wait for a workspace-wide summary counter.
CREATE TABLE stockchief_runtime.sku_cost_totals(
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL,
 quantity_units numeric NOT NULL,
 total_cost_minor numeric NOT NULL,
 PRIMARY KEY(workspace_id,sku_id)
);
CREATE TABLE stockchief_runtime.sku_cost_pending(
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL,
 change_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(workspace_id,sku_id,change_xid)
);
ALTER TABLE stockchief_runtime.sku_cost_pending SET(autovacuum_vacuum_scale_factor=0.02,autovacuum_vacuum_insert_scale_factor=0.02,autovacuum_analyze_scale_factor=0.02);
ALTER TABLE stockchief_runtime.sku_cost_totals SET(autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.02);
CREATE FUNCTION stockchief_queue_sku_cost_summary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  INSERT INTO stockchief_runtime.sku_cost_pending(workspace_id,sku_id)
  SELECT DISTINCT coalesce(n.workspace_id,o.workspace_id),coalesce(n.sku_id,o.sku_id)
  FROM new_costs n FULL JOIN old_costs o USING(workspace_id,sku_id,location_id)
  JOIN workspaces w ON w.id=coalesce(n.workspace_id,o.workspace_id)
  WHERE (n.quantity_units,n.total_cost_minor) IS DISTINCT FROM (o.quantity_units,o.total_cost_minor)
  ON CONFLICT DO NOTHING;
 ELSIF TG_OP='INSERT' THEN
  INSERT INTO stockchief_runtime.sku_cost_pending(workspace_id,sku_id)
  SELECT DISTINCT n.workspace_id,n.sku_id FROM new_costs n JOIN workspaces w ON w.id=n.workspace_id
  ON CONFLICT DO NOTHING;
 ELSE
  INSERT INTO stockchief_runtime.sku_cost_pending(workspace_id,sku_id)
  SELECT DISTINCT n.workspace_id,n.sku_id FROM old_costs n JOIN workspaces w ON w.id=n.workspace_id
  ON CONFLICT DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER zz_sku_cost_summary_insert AFTER INSERT ON accounting_inventory_cost_balances
 REFERENCING NEW TABLE AS new_costs FOR EACH STATEMENT EXECUTE FUNCTION stockchief_queue_sku_cost_summary();
CREATE TRIGGER zz_sku_cost_summary_update AFTER UPDATE ON accounting_inventory_cost_balances
 REFERENCING NEW TABLE AS new_costs OLD TABLE AS old_costs FOR EACH STATEMENT EXECUTE FUNCTION stockchief_queue_sku_cost_summary();
CREATE TRIGGER zz_sku_cost_summary_delete AFTER DELETE ON accounting_inventory_cost_balances
 REFERENCING OLD TABLE AS old_costs FOR EACH STATEMENT EXECUTE FUNCTION stockchief_queue_sku_cost_summary();
-- The trigger lock prevents writes from falling between initialization and
-- capture. No source row or historical receipt is rewritten or removed.
INSERT INTO stockchief_runtime.sku_cost_pending(workspace_id,sku_id)
 SELECT DISTINCT b.workspace_id,b.sku_id FROM accounting_inventory_cost_balances b
 JOIN workspaces w ON w.id=b.workspace_id ON CONFLICT DO NOTHING;
