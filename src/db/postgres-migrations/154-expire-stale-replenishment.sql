ALTER TABLE workspace_autopilot ADD COLUMN replenishment_revision BIGINT NOT NULL DEFAULT 0;
CREATE TABLE stockchief_runtime.replenishment_source_versions (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id TEXT NOT NULL,
 version BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,sku_id)
);
CREATE INDEX work_items_pending_replenishment_sku ON work_items(workspace_id,((recommended_action::jsonb)->>'skuId'))
 WHERE source='postgres_autopilot' AND category IN('stock_transfer','replenishment_plan') AND execution_status IN('WAITING_FOR_APPROVAL','AUTHORIZED');

CREATE FUNCTION stockchief_expire_replenishment(affected JSONB,reason TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE changed_at TEXT := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
 INSERT INTO stockchief_runtime.replenishment_source_versions(workspace_id,sku_id,version)
 SELECT DISTINCT workspace_id,sku_id,1 FROM jsonb_to_recordset(coalesce(affected,'[]')) x(workspace_id TEXT,sku_id TEXT)
 WHERE sku_id IS NOT NULL ORDER BY workspace_id,sku_id
 ON CONFLICT(workspace_id,sku_id) DO UPDATE SET version=replenishment_source_versions.version+1;
 WITH positions AS MATERIALIZED(SELECT DISTINCT workspace_id,sku_id FROM jsonb_to_recordset(coalesce(affected,'[]')) x(workspace_id TEXT,sku_id TEXT)),
 expired AS(UPDATE work_items w SET execution_status='CANCELLED',verification_status='NOT_APPLICABLE',
   outcome=(coalesce(w.outcome,'{}')::jsonb||jsonb_build_object('decision','source_changed','reason',reason,'originalPlanningKey',w.idempotency_key))::text,
   idempotency_key='expired:'||w.id||':'||w.idempotency_key,
   error_message='Stock, incoming quantities or supplier terms changed. Review a fresh recommendation.',completed_at=changed_at
  FROM positions p WHERE w.workspace_id=p.workspace_id AND w.source='postgres_autopilot' AND w.category IN('stock_transfer','replenishment_plan')
   AND w.execution_status IN('WAITING_FOR_APPROVAL','AUTHORIZED') AND w.recommended_action::jsonb->>'skuId'=p.sku_id RETURNING w.id,w.workspace_id)
 INSERT INTO work_item_events(id,workspace_id,work_item_id,event,detail,created_at)
 SELECT 'wievt_'||gen_random_uuid()::text,workspace_id,id,'source_changed',jsonb_build_object('reason',reason,'message','Review a fresh recommendation.')::text,changed_at FROM expired;
 UPDATE workspace_autopilot a SET next_evaluation_at=changed_at,replenishment_revision=replenishment_revision+1
 WHERE a.workspace_id IN(SELECT workspace_id FROM jsonb_to_recordset(coalesce(affected,'[]')) x(workspace_id TEXT,sku_id TEXT))
 ;
END;
$$;
CREATE FUNCTION stockchief_changed_skus_replenishment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM stockchief_expire_replenishment((SELECT jsonb_agg(p) FROM(SELECT DISTINCT workspace_id,sku_id FROM changed_rows)p),TG_ARGV[0]);RETURN NULL;
END;
$$;
CREATE TRIGGER replenish_after_stock_movement AFTER INSERT ON movements REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_skus_replenishment('stock_changed');
CREATE TRIGGER replenish_after_purchase_quote AFTER INSERT ON sku_purchase_costs REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_skus_replenishment('purchase_cost_changed');
CREATE TRIGGER replenish_after_supplier_link_insert AFTER INSERT ON supplier_items REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_skus_replenishment('supplier_terms_changed');
CREATE TRIGGER replenish_after_supplier_link_update AFTER UPDATE ON supplier_items REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_skus_replenishment('supplier_terms_changed');
CREATE TRIGGER replenish_after_policy_insert AFTER INSERT ON reorder_policies REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_skus_replenishment('reorder_settings_changed');
CREATE TRIGGER replenish_after_policy_update AFTER UPDATE ON reorder_policies REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_skus_replenishment('reorder_settings_changed');
CREATE TRIGGER replenish_after_policy_delete AFTER DELETE ON reorder_policies REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_skus_replenishment('reorder_settings_changed');
CREATE FUNCTION stockchief_changed_sales_allocations_replenishment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM stockchief_expire_replenishment((SELECT jsonb_agg(p) FROM(SELECT DISTINCT a.workspace_id,l.sku_id FROM changed_rows a JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id)p),'reservations_changed');RETURN NULL;
END;
$$;
CREATE TRIGGER replenish_after_sales_allocation_insert AFTER INSERT ON sales_order_allocations REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_sales_allocations_replenishment();
CREATE TRIGGER replenish_after_sales_allocation_update AFTER UPDATE ON sales_order_allocations REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_sales_allocations_replenishment();
CREATE TRIGGER replenish_after_sales_allocation_delete AFTER DELETE ON sales_order_allocations REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_sales_allocations_replenishment();
CREATE FUNCTION stockchief_changed_purchase_orders_replenishment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM stockchief_expire_replenishment((SELECT jsonb_agg(p) FROM(SELECT DISTINCT l.workspace_id,l.sku_id FROM changed_orders n JOIN old_orders o ON o.workspace_id=n.workspace_id AND o.id=n.id JOIN purchase_order_lines l ON l.workspace_id=n.workspace_id AND l.purchase_order_id=n.id WHERE n.status IS DISTINCT FROM o.status)p),'incoming_stock_changed');RETURN NULL;
END;
$$;
CREATE TRIGGER replenish_after_purchase_order_status AFTER UPDATE ON purchase_orders REFERENCING NEW TABLE AS changed_orders OLD TABLE AS old_orders FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_purchase_orders_replenishment();
CREATE TRIGGER replenish_after_transfer_lines_insert AFTER INSERT ON inventory_transfer_lines REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_skus_replenishment('transfer_reservations_changed');
CREATE TRIGGER replenish_after_transfer_lines_update AFTER UPDATE ON inventory_transfer_lines REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_skus_replenishment('transfer_reservations_changed');
CREATE FUNCTION stockchief_changed_transfers_replenishment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM stockchief_expire_replenishment((SELECT jsonb_agg(p) FROM(SELECT DISTINCT l.workspace_id,l.sku_id FROM changed_transfers n JOIN old_transfers o ON o.workspace_id=n.workspace_id AND o.id=n.id JOIN inventory_transfer_lines l ON l.workspace_id=n.workspace_id AND l.transfer_id=n.id WHERE n.status IS DISTINCT FROM o.status)p),'transfer_status_changed');RETURN NULL;
END;
$$;
CREATE TRIGGER replenish_after_transfer_status AFTER UPDATE ON inventory_transfers REFERENCING NEW TABLE AS changed_transfers OLD TABLE AS old_transfers FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_transfers_replenishment();

-- Earlier releases did not expire suggestions when their source changed.
-- Preserve their audit history and request fresh evidence once at cutover.
SELECT stockchief_expire_replenishment((SELECT jsonb_agg(p) FROM(
 SELECT DISTINCT workspace_id,recommended_action::jsonb->>'skuId' AS sku_id FROM work_items
 WHERE source='postgres_autopilot' AND category IN('stock_transfer','replenishment_plan')
  AND execution_status IN('WAITING_FOR_APPROVAL','AUTHORIZED'))p),'refresh_after_stock_freshness_upgrade');
