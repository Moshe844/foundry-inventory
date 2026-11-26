-- A business that grows quickly (a bulk import, a store sync) is missing from
-- PostgreSQL's last sample of these tables until autovacuum analyses them
-- again. By default that waits until 10% of a table has changed: about 115,000
-- rows of a 1.15-million-row SKU table. Until then the planner estimates the
-- business at about one SKU, and pages that join SKUs to products, stock or
-- costs can read one side once per row of the other (30-60 s, then the page
-- limit). Sample after 1% of a table (and at least 1,000 rows) has changed, so
-- a growing business is known within a minute. Only the analyse trigger is
-- changed; vacuum thresholds are unchanged.
ALTER TABLE items SET (autovacuum_analyze_scale_factor=0.01,autovacuum_analyze_threshold=1000);
ALTER TABLE skus SET (autovacuum_analyze_scale_factor=0.01,autovacuum_analyze_threshold=1000);
ALTER TABLE balances SET (autovacuum_analyze_scale_factor=0.01,autovacuum_analyze_threshold=1000);
ALTER TABLE item_location_balances SET (autovacuum_analyze_scale_factor=0.01,autovacuum_analyze_threshold=1000);
