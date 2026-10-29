CREATE INDEX IF NOT EXISTS ix_serial_units_sku_page ON serial_units(workspace_id,sku_id,id);
CREATE INDEX IF NOT EXISTS ix_lots_sku_expiry_page ON lots(workspace_id,sku_id,expires_at,code,id);
