ALTER TABLE sales_shipment_kit_lines ADD COLUMN movement_ids JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(movement_ids)='array');
CREATE VIEW sales_shipment_stock_lines AS
 SELECT s.*,NULL::TEXT AS kit_component_id,'[]'::JSONB AS movement_ids FROM sales_shipment_lines s
 UNION ALL
 SELECT id,workspace_id,shipment_id,sales_order_line_id,sku_id,location_id,quantity,created_at,updated_at,kit_component_id,movement_ids FROM sales_shipment_kit_lines;
