-- An assembled kit already in physical stock covers its order quantity
-- without reserving fresh parts. Keep the immutable per-kit recipe snapshot,
-- while allowing its outstanding component requirement to be zero.
ALTER TABLE sales_order_kit_components DROP CONSTRAINT sales_order_kit_components_quantity_required_check;
ALTER TABLE sales_order_kit_components ADD CONSTRAINT sales_order_kit_components_quantity_required_check CHECK(quantity_required>=0);
