-- These covered report inputs also change during stock receipt batches.
-- Cost coverage is updated twice inside a valued receipt; its transient
-- missing-cost entries must be reclaimed without waiting for 20% of all
-- tenants' positions. Movement reports need recent append pages visible too.
ALTER TABLE inventory_cost_coverage_positions SET (
 autovacuum_vacuum_scale_factor=0.02,
 autovacuum_vacuum_insert_scale_factor=0.02,
 autovacuum_analyze_scale_factor=0.02);
ALTER TABLE movements SET (
 autovacuum_vacuum_scale_factor=0.02,
 autovacuum_vacuum_insert_scale_factor=0.02,
 autovacuum_vacuum_insert_threshold=100,
 autovacuum_analyze_scale_factor=0.02);
