-- Kit part planning reads, for each part and warehouse, the parts shipped in
-- kits and the parts used to assemble kits. Neither history had an index by
-- part, so every planning pass would read the whole inventory's history.
CREATE INDEX sales_shipment_kit_lines_part_demand ON sales_shipment_kit_lines(workspace_id,sku_id,location_id);
CREATE INDEX manufacturing_material_uses_part_demand ON manufacturing_material_uses(workspace_id,sku_id,location_id);
