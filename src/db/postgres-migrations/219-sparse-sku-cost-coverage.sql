-- Both global missing-cost totals and visible-item warnings need only the
-- nonzero gaps. Cover SKU lookups without reading every fully costed bin.
-- NaN remains included by PostgreSQL's numeric comparison, preserving the
-- existing named-position validation path for damaged quantities.
CREATE INDEX idx_inventory_cost_coverage_missing_sku
 ON inventory_cost_coverage_positions(workspace_id,sku_id)
 INCLUDE(missing_units,physical_units) WHERE missing_units>0;
