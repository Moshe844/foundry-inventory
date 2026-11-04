-- Home counts recent work, not every old proposal. Keep date parsing out of
-- the read path and support absolute dates from older records as well as UTC.
-- These are ordinary indexes; no shared counter rows or write triggers.
CREATE INDEX idx_work_items_created_instant ON work_items
 (workspace_id,stockchief_movement_instant(created_at)) INCLUDE(created_at);
CREATE INDEX idx_work_items_completed_instant ON work_items
 (workspace_id,stockchief_movement_instant(completed_at)) INCLUDE(completed_at,approval_requirement)
 WHERE execution_status='COMPLETED';
CREATE INDEX idx_attention_detected_instant ON attention_items
 (workspace_id,stockchief_movement_instant(first_detected_at)) INCLUDE(first_detected_at);
CREATE INDEX idx_attention_resolved_instant ON attention_items
 (workspace_id,stockchief_movement_instant(resolved_at)) INCLUDE(resolved_at)
 WHERE status='RESOLVED';
ANALYZE work_items;
ANALYZE attention_items;
