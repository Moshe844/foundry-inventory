-- Two movement indexes inherited from the original schema are never used by
-- the PostgreSQL application (no query filters movements by reference alone or
-- by group id) and cost about 950 MB on staging. Lookups by reference go
-- through the SKU/location/time index together with the SKU and location.
DROP INDEX IF EXISTS idx_movements_workspace_reference;
DROP INDEX IF EXISTS idx_movements_group;
