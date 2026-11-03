-- New business tables start empty, so their baseline is exact and complete.
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['warehouse_count_campaigns','warehouse_count_campaign_lines'] LOOP
  INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES(tab::regclass,'octet_length(to_jsonb(t)::text)');
  INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete) SELECT id,tab::regclass,true FROM workspaces;
  EXECUTE format('CREATE TRIGGER commercial_storage_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS after_rows FOR EACH STATEMENT EXECUTE FUNCTION commercial_track_storage()',tab);
  EXECUTE format('CREATE TRIGGER commercial_storage_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS before_rows NEW TABLE AS after_rows FOR EACH STATEMENT EXECUTE FUNCTION commercial_track_storage()',tab);
  EXECUTE format('CREATE TRIGGER commercial_storage_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS before_rows FOR EACH STATEMENT EXECUTE FUNCTION commercial_track_storage()',tab);
 END LOOP;
END $$;
