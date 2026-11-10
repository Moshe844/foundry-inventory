-- Keep exact supplier grams and millimetres on the native product and parcel.
-- Existing integer values convert without changing their value or unit.
ALTER TABLE skus
 ALTER COLUMN weight_grams TYPE numeric USING weight_grams::numeric,
 ALTER COLUMN length_mm TYPE numeric USING length_mm::numeric,
 ALTER COLUMN width_mm TYPE numeric USING width_mm::numeric,
 ALTER COLUMN height_mm TYPE numeric USING height_mm::numeric;

ALTER TABLE sales_shipments ALTER COLUMN weight_grams TYPE numeric USING weight_grams::numeric;
ALTER TABLE shipment_packages
 ALTER COLUMN weight_grams TYPE numeric USING weight_grams::numeric,
 ALTER COLUMN length_mm TYPE numeric USING length_mm::numeric,
 ALTER COLUMN width_mm TYPE numeric USING width_mm::numeric,
 ALTER COLUMN height_mm TYPE numeric USING height_mm::numeric;

