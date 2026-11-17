-- Measure the new per-inventory privacy records and briefing preference using
-- the same storage ledger as the rest of the customer's saved business data.
DO $$
DECLARE target regclass; expression text := 'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))';
BEGIN
 FOREACH target IN ARRAY ARRAY[
  'workspace_briefing_preferences'::regclass,
  'shopify_privacy_work'::regclass,
  'shopify_privacy_access'::regclass,
  'shopify_privacy_subjects'::regclass
 ] LOOP
  INSERT INTO commercial_storage_tables(relation,bytes_expression)
   VALUES(target,expression) ON CONFLICT(relation) DO NOTHING;
  EXECUTE format('INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_bytes,baseline_complete)
   SELECT w.id,$1,coalesce(m.bytes,0),true FROM workspaces w
   LEFT JOIN (SELECT t.workspace_id,sum(%s)::bigint bytes FROM %s t GROUP BY t.workspace_id) m ON m.workspace_id=w.id
   ON CONFLICT(workspace_id,relation) DO NOTHING',expression,target) USING target;
 END LOOP;
END $$;
