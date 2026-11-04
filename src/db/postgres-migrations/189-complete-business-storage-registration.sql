-- Include business tables added after the original storage-ledger migration.
-- Existing records remain intact and become the measured opening baseline.
DO $$
DECLARE tab record; byte_columns text[]; raw_expression text; expression text;
BEGIN
 FOR tab IN SELECT c.oid,n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind='r' AND n.nspname='public' AND c.relname !~ '^(commercial_|platform_)'
 AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND a.attnum>0 AND NOT a.attisdropped)
 AND NOT EXISTS(SELECT 1 FROM commercial_storage_tables st WHERE st.relation=c.oid)
 ORDER BY c.oid
 LOOP
  EXECUTE format('LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE',tab.nspname,tab.relname);
  SELECT coalesce(array_agg(a.attname ORDER BY a.attnum),'{}'::text[]),coalesce(string_agg(format('+coalesce(octet_length(t.%I),0)',a.attname),''),'')
   INTO byte_columns,raw_expression FROM pg_attribute a WHERE a.attrelid=tab.oid AND a.attnum>0 AND NOT a.attisdropped AND a.atttypid='bytea'::regtype;
  expression:=format('octet_length(convert_to((to_jsonb(t)-%L::text[])::text,''UTF8''))%s',byte_columns||ARRAY['updated_at','last_used_at','last_seen_at','last_synced_at','last_activity_at','last_attempt_at'],raw_expression);
  INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES(tab.oid,expression);
  INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete) SELECT id,tab.oid,true FROM workspaces;
  EXECUTE format('WITH measured AS(SELECT t.workspace_id,sum(%s)::bigint bytes FROM %I.%I t WHERE t.workspace_id IS NOT NULL GROUP BY t.workspace_id)
   UPDATE commercial_storage_usage u SET baseline_bytes=m.bytes FROM measured m WHERE u.workspace_id=m.workspace_id AND u.relation=$1',expression,tab.nspname,tab.relname) USING tab.oid;
  EXECUTE format('CREATE TRIGGER commercial_storage_insert AFTER INSERT ON %I.%I REFERENCING NEW TABLE AS after_rows FOR EACH STATEMENT EXECUTE FUNCTION commercial_track_storage()',tab.nspname,tab.relname);
  EXECUTE format('CREATE TRIGGER commercial_storage_update AFTER UPDATE ON %I.%I REFERENCING OLD TABLE AS before_rows NEW TABLE AS after_rows FOR EACH STATEMENT EXECUTE FUNCTION commercial_track_storage()',tab.nspname,tab.relname);
  EXECUTE format('CREATE TRIGGER commercial_storage_delete AFTER DELETE ON %I.%I REFERENCING OLD TABLE AS before_rows FOR EACH STATEMENT EXECUTE FUNCTION commercial_track_storage()',tab.nspname,tab.relname);
 END LOOP;
END $$;
