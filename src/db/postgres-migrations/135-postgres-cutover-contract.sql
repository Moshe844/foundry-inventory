ALTER TABLE migration_packages ADD COLUMN postgres_state JSONB;
CREATE UNIQUE INDEX idx_postgres_cutover_active ON migration_packages(workspace_id)
 WHERE postgres_state IS NOT NULL AND status NOT IN ('CUTOVER_ACTIVE','CANCELLED','FAILED');
CREATE TABLE migration_cutover_batches (
 package_id TEXT NOT NULL REFERENCES migration_packages(id) ON DELETE CASCADE,
 batch_key TEXT NOT NULL,
 previous_cursor TEXT,
 source_cursor TEXT,
 content_hash TEXT NOT NULL,
 evidence JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(package_id,batch_key)
);
CREATE TABLE migration_record_dependencies (
 package_id TEXT NOT NULL REFERENCES migration_packages(id) ON DELETE CASCADE,
 record_id TEXT NOT NULL REFERENCES migration_records(id) ON DELETE CASCADE,
 entity_type TEXT NOT NULL,
 source_key TEXT NOT NULL,
 PRIMARY KEY(record_id,entity_type,source_key)
);
CREATE INDEX idx_cutover_dependencies_lookup ON migration_record_dependencies(package_id,entity_type,source_key);
CREATE INDEX idx_cutover_record_page ON migration_records(package_id,id);
