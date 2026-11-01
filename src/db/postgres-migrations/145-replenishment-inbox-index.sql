ALTER TABLE work_items
 ADD COLUMN inbox_kind TEXT GENERATED ALWAYS AS (recommended_action::jsonb->>'type') STORED,
 ADD COLUMN inbox_location TEXT GENERATED ALWAYS AS (coalesce(recommended_action::jsonb->>'destinationLocationId','')) STORED,
 ADD COLUMN inbox_currency TEXT GENERATED ALWAYS AS (coalesce(recommended_action::jsonb->>'currency','')) STORED,
 ADD COLUMN inbox_value NUMERIC GENERATED ALWAYS AS (CASE WHEN (recommended_action::jsonb->>'value')~'^[0-9]+([.][0-9]+)?$' THEN (recommended_action::jsonb->>'value')::numeric END) STORED;
CREATE INDEX work_items_pending_replenishment_inbox ON work_items(workspace_id,inbox_currency,inbox_value DESC NULLS LAST,priority DESC,created_at,id)
 INCLUDE(inbox_kind,inbox_location)
 WHERE source='postgres_autopilot' AND category IN ('stock_transfer','replenishment_plan') AND NOT (coalesce(outcome,'{}')::jsonb ? 'decision') AND approval_requirement<>'NONE' AND execution_status NOT IN ('COMPLETED','CANCELLED','FAILED');
