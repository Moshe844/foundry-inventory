ALTER TABLE locations ADD COLUMN IF NOT EXISTS shipping_email TEXT;
ALTER TABLE locations ADD CONSTRAINT locations_shipping_email_length
  CHECK (shipping_email IS NULL OR char_length(shipping_email) BETWEEN 3 AND 254);
