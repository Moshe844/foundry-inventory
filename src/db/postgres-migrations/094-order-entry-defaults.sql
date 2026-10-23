-- Order contacts are snapshots, separate from the customer's future defaults.
ALTER TABLE sales_orders ADD COLUMN contact_email TEXT;
ALTER TABLE sales_orders ADD COLUMN contact_phone TEXT;
UPDATE sales_orders o SET contact_email=c.email,contact_phone=c.phone
FROM customers c WHERE c.workspace_id=o.workspace_id AND c.id=o.customer_id;
-- Physical specifications are per sellable variant, in explicit metric units.
-- weight_grams already exists in the canonical catalogue schema.
ALTER TABLE skus ADD COLUMN length_mm BIGINT CHECK(length_mm>0);
ALTER TABLE skus ADD COLUMN width_mm BIGINT CHECK(width_mm>0);
ALTER TABLE skus ADD COLUMN height_mm BIGINT CHECK(height_mm>0);
