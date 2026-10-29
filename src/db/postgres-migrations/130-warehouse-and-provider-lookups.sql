-- Provider matching and barcode scanners use these exact expressions. The
-- import index on lower(btrim(code)) cannot serve lower(code) predicates.
CREATE INDEX IF NOT EXISTS ix_skus_active_code_lookup ON skus(workspace_id,lower(code)) WHERE is_active=1;
CREATE INDEX IF NOT EXISTS ix_skus_active_barcode_lookup ON skus(workspace_id,lower(barcode)) WHERE is_active=1;
CREATE INDEX IF NOT EXISTS ix_lots_sku_code_lookup ON lots(workspace_id,sku_id,lower(code));
CREATE INDEX IF NOT EXISTS ix_serial_units_sku_serial_lookup ON serial_units(workspace_id,sku_id,lower(serial));
CREATE INDEX IF NOT EXISTS ix_wave_scans_lot_reservations ON fulfillment_wave_scans(workspace_id,lot_id,line_id) INCLUDE(quantity) WHERE status='ACCEPTED' AND lot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_wave_scans_serial_reservations ON fulfillment_wave_scans(workspace_id,serial_unit_id,line_id) WHERE status='ACCEPTED' AND serial_unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_sales_orders_ready_page ON sales_orders(workspace_id,needed_by,order_number,id) WHERE status IN ('CONFIRMED','PARTIALLY_FULFILLED');
CREATE INDEX IF NOT EXISTS ix_wave_shipments_page ON fulfillment_wave_shipments(workspace_id,wave_id,shipment_id);
