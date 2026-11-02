-- A scoped agent may read this reviewed view only with its own table rights
-- and row policies. View-owner privileges must never bypass tenant isolation.
ALTER VIEW public.sales_stock_commitments SET (security_invoker = true);
