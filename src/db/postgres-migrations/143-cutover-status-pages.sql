-- Validation and reconciliation consume a stable id-ordered page for one status.
-- Keep completed source records out of subsequent page scans.
CREATE INDEX idx_cutover_status_page ON migration_records(package_id,status,id);
