-- The governed purchase-order contract already accepts a customer-supplied
-- reference. Preserve it on the canonical record instead of silently dropping
-- it at execution. Do not infer or backfill references on existing orders.
ALTER TABLE purchase_orders ADD COLUMN reference TEXT;
