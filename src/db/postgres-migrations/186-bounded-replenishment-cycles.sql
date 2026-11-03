-- Demand reads must not cast every historical receipt's text timestamp. Keep
-- the small issue-only projection typed; original movement/audit rows stay intact.
CREATE TABLE stockchief_runtime.replenishment_demand_events (
 movement_id TEXT PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id TEXT NOT NULL,
 location_id TEXT NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL,
 issued NUMERIC NOT NULL CHECK(issued>0)
);
CREATE INDEX replenishment_demand_window ON stockchief_runtime.replenishment_demand_events(workspace_id,occurred_at,sku_id,location_id);
CREATE INDEX replenishment_demand_sku ON stockchief_runtime.replenishment_demand_events(workspace_id,sku_id,occurred_at);
INSERT INTO stockchief_runtime.replenishment_demand_events
 SELECT id,workspace_id,sku_id,location_id,occurred_at::timestamptz,-quantity_delta
 FROM movements WHERE operation='issue' AND quantity_delta<0;
CREATE FUNCTION stockchief_record_replenishment_demand() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO stockchief_runtime.replenishment_demand_events
 SELECT id,workspace_id,sku_id,location_id,occurred_at::timestamptz,-quantity_delta
 FROM demand_rows WHERE operation='issue' AND quantity_delta<0;
 RETURN NULL;
END $$;
CREATE TRIGGER replenish_record_demand AFTER INSERT ON movements REFERENCING NEW TABLE AS demand_rows
 FOR EACH STATEMENT EXECUTE FUNCTION stockchief_record_replenishment_demand();

-- One reusable snapshot per inventory, not another permanent catalogue copy
-- per page/cycle. It survives worker restarts and is shared by forecast + plan.
CREATE TABLE stockchief_runtime.replenishment_planning_runs (
 workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 cycle_id TEXT NOT NULL,
 revision BIGINT NOT NULL,
 started_at TIMESTAMPTZ NOT NULL,
 completed_at TIMESTAMPTZ
);
CREATE TABLE stockchief_runtime.replenishment_planning_demand (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id TEXT NOT NULL,location_id TEXT NOT NULL,
 issue_events BIGINT NOT NULL,issued NUMERIC NOT NULL,
 PRIMARY KEY(workspace_id,sku_id,location_id)
);
CREATE TABLE stockchief_runtime.replenishment_planning_eligible (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id TEXT NOT NULL,
 PRIMARY KEY(workspace_id,sku_id)
);
CREATE INDEX replenishment_executing_import ON import_executions(workspace_id,started_at) WHERE status='EXECUTING';
ALTER TABLE workspace_autopilot ADD COLUMN replenishment_dirty_at TEXT;

CREATE OR REPLACE FUNCTION stockchief_expire_replenishment(affected JSONB,reason TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE changed_at TEXT := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
 INSERT INTO stockchief_runtime.replenishment_source_versions(workspace_id,sku_id,version)
 SELECT DISTINCT workspace_id,sku_id,1 FROM jsonb_to_recordset(coalesce(affected,'[]')) x(workspace_id TEXT,sku_id TEXT)
 WHERE sku_id IS NOT NULL ORDER BY workspace_id,sku_id
 ON CONFLICT(workspace_id,sku_id) DO UPDATE SET version=replenishment_source_versions.version+1;
 WITH positions AS MATERIALIZED(SELECT DISTINCT workspace_id,sku_id FROM jsonb_to_recordset(coalesce(affected,'[]')) x(workspace_id TEXT,sku_id TEXT)),
 expired AS(UPDATE work_items w SET execution_status='CANCELLED',verification_status='NOT_APPLICABLE',
   outcome=(coalesce(w.outcome,'{}')::jsonb||jsonb_build_object('decision','source_changed','reason',reason,'originalPlanningKey',w.idempotency_key))::text,
   idempotency_key='expired:'||w.id||':'||w.idempotency_key,
   error_message='Stock, incoming quantities or supplier terms changed. Review a fresh recommendation.',completed_at=changed_at
  FROM positions p WHERE w.workspace_id=p.workspace_id AND w.source='postgres_autopilot' AND w.category IN('stock_transfer','replenishment_plan')
   AND w.execution_status IN('WAITING_FOR_APPROVAL','AUTHORIZED') AND w.recommended_action::jsonb->>'skuId'=p.sku_id RETURNING w.id,w.workspace_id)
 INSERT INTO work_item_events(id,workspace_id,work_item_id,event,detail,created_at)
 SELECT 'wievt_'||gen_random_uuid()::text,workspace_id,id,'source_changed',jsonb_build_object('reason',reason,'message','Review a fresh recommendation.')::text,changed_at FROM expired;
 -- Invalidate affected proposals immediately, but coalesce catalogue planning.
 -- Later batches must not change the due time, revision or restart a page walk.
 UPDATE workspace_autopilot a SET replenishment_dirty_at=changed_at,
  replenishment_revision=replenishment_revision+1,
  next_evaluation_at=to_char(greatest(changed_at::timestamptz+interval '2 minutes',
    coalesce(a.last_evaluated_at::timestamptz,'-infinity'::timestamptz)+interval '5 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 WHERE a.replenishment_dirty_at IS NULL AND a.workspace_id IN(
  SELECT workspace_id FROM jsonb_to_recordset(coalesce(affected,'[]')) x(workspace_id TEXT,sku_id TEXT));
END;
$$;
