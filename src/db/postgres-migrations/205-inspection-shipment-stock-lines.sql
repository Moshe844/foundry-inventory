-- The order and shipment pages read this view. A scoped read-only agent may use
-- it only with its own table rights and row policies: view-owner privileges
-- must never bypass tenant isolation.
ALTER VIEW public.sales_shipment_stock_lines SET (security_invoker = true);
