-- Preserve the import_id-leading foreign-key lookup needed by business
-- deletion, while also ordering a cleanup page. With stale statistics the
-- single-column index could read and sort the entire import for every page.
CREATE INDEX IF NOT EXISTS ix_import_execution_identities_import_page
 ON import_execution_identities(import_id,workspace_id,row_number,row_id);
DROP INDEX IF EXISTS ix_import_execution_identities_import_id;
