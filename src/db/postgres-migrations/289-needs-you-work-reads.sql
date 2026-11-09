-- Needs you counts the urgent replenishment decisions of each group from an
-- index holding only those, instead of reading every pending decision.
CREATE INDEX IF NOT EXISTS work_items_pending_replenishment_urgent ON work_items(workspace_id,inbox_kind,inbox_location,inbox_currency)
 WHERE source='postgres_autopilot' AND category IN ('stock_transfer','replenishment_plan') AND NOT (coalesce(outcome,'{}')::jsonb ? 'decision')
  AND approval_requirement<>'NONE' AND execution_status NOT IN ('COMPLETED','CANCELLED','FAILED') AND urgency='immediate';

-- Work items grow by inserts. Vacuum them often enough that the visibility map
-- stays current, so the pending-work indexes answer without visiting the table
-- (staging had 62,646 heap visits per Needs you read before this).
ALTER TABLE work_items SET (autovacuum_vacuum_insert_scale_factor=0.01,autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.02);
