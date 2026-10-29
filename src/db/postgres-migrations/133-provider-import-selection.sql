-- Bound automatic-import discovery and setup checks to the pending records.
CREATE INDEX connection_external_pending_page ON connection_external_records
 (workspace_id,connector_id,entity_type,external_id)
 WHERE selected=1 AND mapping_status='UNMAPPED';
CREATE INDEX connection_external_product_family ON connection_external_records
 (workspace_id,connector_id,entity_type,(COALESCE(NULLIF(parent_external_id,''),external_id)))
 WHERE selected=1;
