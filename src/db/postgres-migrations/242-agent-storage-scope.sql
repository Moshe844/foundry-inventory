-- Every playbook result has an explicit inventory boundary, including when a
-- caller accidentally supplies another inventory's parent identity.
ALTER TABLE stockchief_runtime.agent_playbook_runs ADD COLUMN workspace_id text;
UPDATE stockchief_runtime.agent_playbook_runs r SET workspace_id=b.workspace_id
 FROM stockchief_runtime.agent_playbooks b WHERE b.id=r.playbook_id;
ALTER TABLE stockchief_runtime.agent_playbook_runs ALTER COLUMN workspace_id SET NOT NULL;
CREATE UNIQUE INDEX agent_playbooks_scoped_identity ON stockchief_runtime.agent_playbooks(workspace_id,id);
ALTER TABLE stockchief_runtime.agent_playbook_runs ADD CONSTRAINT agent_playbook_run_inventory
 FOREIGN KEY(workspace_id,playbook_id) REFERENCES stockchief_runtime.agent_playbooks(workspace_id,id) ON DELETE CASCADE;

-- Register the new workflow data for background measurement. No per-write
-- storage trigger or account-wide quota lock is added. Existing nonempty data
-- is marked for measurement rather than silently assigned a zero-byte total.
DO $$
DECLARE relation regclass; workspace_attribute smallint; relation_name text;
BEGIN
 FOREACH relation IN ARRAY ARRAY[
  'stockchief_runtime.agent_playbooks','stockchief_runtime.agent_playbook_runs',
  'stockchief_runtime.agent_time_samples','stockchief_runtime.purchase_requests',
  'stockchief_runtime.lot_recall_events','stockchief_runtime.lot_certificate_requirements','stockchief_runtime.lot_certificates',
  'stockchief_runtime.shipbob_sandbox_orders','stockchief_runtime.shipbob_sandbox_stock','stockchief_runtime.shipbob_sandbox_rules',
  'stockchief_runtime.orderful_orders','stockchief_runtime.orderful_changes','stockchief_runtime.orderful_outbound',
  'stockchief_runtime.orderful_rules','stockchief_runtime.orderful_inbox']::regclass[]
 LOOP
  INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
   (relation,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))') ON CONFLICT DO NOTHING;
  EXECUTE format('INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
   SELECT w.id,$1,NOT EXISTS(SELECT 1 FROM %s t WHERE t.workspace_id=w.id) FROM workspaces w
   ON CONFLICT(workspace_id,relation) DO NOTHING',relation) USING relation;
  SELECT a.attnum,c.relname INTO workspace_attribute,relation_name FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
   WHERE a.attrelid=relation AND a.attname='workspace_id' AND NOT a.attisdropped;
  IF NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
   WHERE i.indrelid=relation AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree'
    AND i.indkey[0]=workspace_attribute) THEN
   EXECUTE format('CREATE INDEX %I ON %s(workspace_id)','agent_storage_'||relation_name,relation);
  END IF;
 END LOOP;
END $$;
