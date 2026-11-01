-- The general inbox also includes manual and workflow-owned decisions. The
-- replenishment-only index cannot answer an empty general inbox, so that read
-- previously scanned closed work and other inventories' stored payloads.
CREATE INDEX work_items_pending_workspace_order
 ON work_items(workspace_id,priority DESC,created_at,id)
 WHERE approval_requirement<>'NONE'
  AND execution_status NOT IN ('COMPLETED','CANCELLED','FAILED');
