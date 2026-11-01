-- Planned kits remain parent order units until handoff, when their actual
-- component movement evidence is recorded separately.
ALTER TABLE sales_shipment_lines ADD COLUMN uses_kit_components BOOLEAN NOT NULL DEFAULT false;
CREATE OR REPLACE VIEW sales_shipment_stock_lines AS
 SELECT s.id,s.workspace_id,s.shipment_id,s.sales_order_line_id,s.sku_id,s.location_id,s.quantity,s.created_at,s.updated_at,
 NULL::TEXT AS kit_component_id,'[]'::JSONB AS movement_ids FROM sales_shipment_lines s
 WHERE NOT s.uses_kit_components OR NOT EXISTS(SELECT 1 FROM sales_shipment_kit_lines p WHERE p.workspace_id=s.workspace_id AND p.shipment_id=s.shipment_id AND p.sales_order_line_id=s.sales_order_line_id)
 UNION ALL
 SELECT id,workspace_id,shipment_id,sales_order_line_id,sku_id,location_id,quantity,created_at,updated_at,kit_component_id,movement_ids FROM sales_shipment_kit_lines;
