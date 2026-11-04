-- Modern imported details never need to visit legacy field rows. Keep that
-- compatibility lookup small even after millions of document-style facts.
CREATE INDEX catalog_source_legacy_position ON catalog_source_facts(workspace_id,source_import_id,sku_id,source_row)
 WHERE attributes IS NULL;

CREATE OR REPLACE FUNCTION stockchief_expire_replenishment(affected JSONB,reason TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE changed_at TEXT := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
 INSERT INTO stockchief_runtime.replenishment_source_versions(workspace_id,sku_id,version)
 SELECT DISTINCT workspace_id,sku_id,1 FROM jsonb_to_recordset(coalesce(affected,'[]')) x(workspace_id TEXT,sku_id TEXT)
 WHERE sku_id IS NOT NULL ORDER BY workspace_id,sku_id
 ON CONFLICT(workspace_id,sku_id) DO UPDATE SET version=replenishment_source_versions.version+1;
 WITH positions AS MATERIALIZED(SELECT DISTINCT workspace_id,sku_id FROM jsonb_to_recordset(coalesce(affected,'[]')) x(workspace_id TEXT,sku_id TEXT)),
 targets AS MATERIALIZED(SELECT p.workspace_id,matched.id FROM positions p
  CROSS JOIN LATERAL(SELECT id FROM work_items pending WHERE pending.workspace_id=p.workspace_id
   AND pending.source='postgres_autopilot' AND pending.category IN('stock_transfer','replenishment_plan')
   AND pending.execution_status IN('WAITING_FOR_APPROVAL','AUTHORIZED')
   AND pending.recommended_action::jsonb->>'skuId'=p.sku_id OFFSET 0) matched),
 expired AS(UPDATE work_items w SET execution_status='CANCELLED',verification_status='NOT_APPLICABLE',
   outcome=(coalesce(w.outcome,'{}')::jsonb||jsonb_build_object('decision','source_changed','reason',reason,'originalPlanningKey',w.idempotency_key))::text,
   idempotency_key='expired:'||w.id||':'||w.idempotency_key,
   error_message='Stock, incoming quantities or supplier terms changed. Review a fresh recommendation.',completed_at=changed_at
  -- An UPDATE join over the unknown-size JSON input can choose a scan of all
  -- work history. Materialize the affected IDs as an initplan so this write
  -- uses primary-key lookups, even before statistics catch up with a bulk run.
  WHERE w.id=ANY(ARRAY(SELECT id FROM targets)) AND w.workspace_id IN(SELECT workspace_id FROM positions)
   AND w.source='postgres_autopilot' AND w.category IN('stock_transfer','replenishment_plan')
   AND w.execution_status IN('WAITING_FOR_APPROVAL','AUTHORIZED') RETURNING w.id,w.workspace_id)
 INSERT INTO work_item_events(id,workspace_id,work_item_id,event,detail,created_at)
 SELECT 'wievt_'||lpad(to_hex((extract(epoch FROM clock_timestamp())*1000)::bigint),12,'0')||replace(gen_random_uuid()::text,'-',''),workspace_id,id,'source_changed',jsonb_build_object('reason',reason,'message','Review a fresh recommendation.')::text,changed_at FROM expired;
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
