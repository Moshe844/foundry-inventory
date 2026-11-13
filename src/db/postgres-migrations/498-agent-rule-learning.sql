-- Jobs 208 and 209: StockChief offers to stop asking about a routine the
-- owner always approved (208) and suggests a rule after the same fix is made
-- again and again (209). Both offers come from records, so the only thing kept
-- is the owner's answer: accepted, or "keep asking" / "not now", with the time
-- of the newest evidence the owner saw. Only evidence recorded after that time
-- can bring the same offer back, and a repeated accept finds its answer here.
CREATE TABLE stockchief_runtime.agent_learning_decisions (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id int NOT NULL CHECK (job_id IN (208,209)),
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 80),
  scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 300),
  decision text NOT NULL CHECK (decision IN ('accepted','declined')),
  through timestamptz NOT NULL,
  rule_reference text,
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,job_id,kind,scope_key)
);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_learning_decisions'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.agent_learning_decisions'::regclass,true FROM workspaces;

-- Job 208 reads each routine scope's latest decisions, newest first.
CREATE INDEX agent_learning_approval_runs ON stockchief_runtime.assistant_action_proposals
  (workspace_id,action_type,(payload#>>'{training,key}'),created_at DESC)
  WHERE payload#>>'{training,key}' IS NOT NULL AND status IN ('EXECUTED','CANCELLED');
-- Job 209 reads repeated draft purchase-order quantity changes, repeated moves
-- of the same stock and repeatedly declined reorder suggestions.
CREATE INDEX agent_learning_po_revisions ON purchase_order_events(workspace_id,created_at)
  WHERE event='draft_line_revised';
CREATE INDEX agent_learning_moves ON movements(workspace_id,occurred_at,sku_id,location_id)
  WHERE operation='transfer' AND leg='in';
CREATE INDEX agent_learning_declined_work ON work_items(workspace_id,completed_at)
  WHERE execution_status='CANCELLED';

-- Job 208's offers reach Needs you as an agent notice.
DO $$
DECLARE allowed text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO allowed FROM pg_constraint
   WHERE conname='agent_operational_notices_job_id_check' AND conrelid='stockchief_runtime.agent_operational_notices'::regclass;
  IF allowed IS NULL OR position('ARRAY[' IN allowed)=0 THEN
    RAISE EXCEPTION 'The notice job list has an unexpected form.';
  END IF;
  IF allowed !~ '\m208\M' THEN
    EXECUTE 'ALTER TABLE stockchief_runtime.agent_operational_notices DROP CONSTRAINT agent_operational_notices_job_id_check, ADD CONSTRAINT agent_operational_notices_job_id_check '
      ||replace(allowed,'ARRAY[','ARRAY[208, ');
  END IF;
END $$;
