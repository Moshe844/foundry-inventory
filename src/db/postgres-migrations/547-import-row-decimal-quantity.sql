-- Import evidence keeps a measured row's exact quantity (2.25 m). The column
-- held whole numbers only, so a decimal row recorded a rounded value although
-- its stock, cost and journal were exact. Rows already rounded are restored
-- from the row's own saved parsed quantity, only where rounding explains the
-- difference; every other row keeps its stored value.
ALTER TABLE import_rows ALTER COLUMN quantity TYPE numeric USING
  CASE WHEN quantity IS NOT NULL AND parsed::jsonb->>'quantity' ~ '^[+-]?[0-9]+\.[0-9]+$'
        AND round((parsed::jsonb->>'quantity')::numeric)=quantity
       THEN (parsed::jsonb->>'quantity')::numeric
       ELSE quantity::numeric END;
