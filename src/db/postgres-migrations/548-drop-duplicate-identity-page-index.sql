-- import_execution_identity_page (workspace_id,import_id,row_number,row_id)
-- duplicated ix_import_execution_identities_import_page (import_id,workspace_id,
-- row_number,row_id): every query filters both columns by equality, so the
-- import_id-leading index (also needed for import_plans foreign-key lookups)
-- serves the same ordered pages. Each preview and approval row wrote both.
DROP INDEX IF EXISTS import_execution_identity_page;
