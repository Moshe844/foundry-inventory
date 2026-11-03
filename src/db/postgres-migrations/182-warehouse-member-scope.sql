-- NULL preserves existing inventory-wide membership. An empty array denies all sites.
ALTER TABLE users ADD COLUMN warehouse_location_ids JSONB
 CHECK(warehouse_location_ids IS NULL OR jsonb_typeof(warehouse_location_ids)='array');
ALTER TABLE users ADD CONSTRAINT owner_warehouse_scope CHECK(role<>'owner' OR warehouse_location_ids IS NULL);
-- Existing measured JSON rows gain the new null field without an UPDATE trigger.
-- Pending baselines will measure the complete new row and need no adjustment.
UPDATE commercial_storage_usage u SET baseline_bytes=baseline_bytes+added.bytes
FROM (SELECT workspace_id,sum(octet_length(to_jsonb(t)::text)-octet_length((to_jsonb(t)-'warehouse_location_ids')::text))::bigint bytes FROM users t GROUP BY workspace_id) added
WHERE u.workspace_id=added.workspace_id AND u.relation='users'::regclass AND u.baseline_complete;
