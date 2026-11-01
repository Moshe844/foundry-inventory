CREATE INDEX kit_order_components_stock ON sales_order_kit_components(workspace_id,component_sku_id,sales_order_line_id);
CREATE VIEW sales_stock_commitments AS
 SELECT a.workspace_id,l.sku_id,a.location_id,a.quantity,l.id AS sales_order_line_id,o.id AS sales_order_id,NULL::text AS kit_component_id
 FROM sales_order_allocations a JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id
 JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id WHERE o.status NOT IN('CANCELLED','FULFILLED')
 UNION ALL
 SELECT a.workspace_id,c.component_sku_id,a.location_id,a.quantity,l.id,o.id,c.id
 FROM sales_order_kit_allocations a JOIN sales_order_kit_components c ON c.workspace_id=a.workspace_id AND c.id=a.kit_component_id
 JOIN sales_order_lines l ON l.workspace_id=c.workspace_id AND l.id=c.sales_order_line_id
 JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id WHERE o.status NOT IN('CANCELLED','FULFILLED');
DO $$
DECLARE target TEXT;
BEGIN
 FOREACH target IN ARRAY ARRAY['kit_components','sales_order_kit_components','sales_order_kit_allocations'] LOOP
 EXECUTE format('CREATE TRIGGER read_model_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model()',target);
 EXECUTE format('CREATE TRIGGER read_model_update AFTER UPDATE ON %I REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model()',target);
 EXECUTE format('CREATE TRIGGER read_model_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model()',target);
 END LOOP;
END;
$$;
