-- Import provenance and last applied values belong to the existing scoped
-- mapping. Remapping never transfers authority to a different local record.
ALTER TABLE connection_mappings ADD COLUMN catalog_sync_state TEXT NOT NULL DEFAULT '{}';
