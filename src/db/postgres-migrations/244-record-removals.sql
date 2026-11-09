-- A removal that runs in the background (undoing a large import) keeps its
-- reviewed summary, progress and outcome. Removals that finish in the request
-- leave their trace in the business records they change.
CREATE TABLE record_removals(
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('import')),
 record_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('RUNNING','COMPLETED','FAILED')),
 summary jsonb NOT NULL DEFAULT '{}'::jsonb,
 progress jsonb NOT NULL DEFAULT '{}'::jsonb,
 error text,
 created_by_user_id text NOT NULL,
 created_at text NOT NULL,
 completed_at text
);
CREATE UNIQUE INDEX record_removals_one_live ON record_removals(workspace_id,kind,record_id) WHERE status<>'FAILED';
CREATE INDEX record_removals_workspace ON record_removals(workspace_id);

-- A dismissed Needs you entry leaves every cached list at once.
CREATE TRIGGER read_model_insert AFTER INSERT ON needs_you_dismissals REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
CREATE TRIGGER read_model_update AFTER UPDATE ON needs_you_dismissals REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
CREATE TRIGGER read_model_delete AFTER DELETE ON needs_you_dismissals REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();

DO $$
DECLARE relation regclass;
BEGIN
 FOREACH relation IN ARRAY ARRAY['record_removals']::regclass[]
 LOOP
  INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
   (relation,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))') ON CONFLICT DO NOTHING;
  EXECUTE format('INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
   SELECT w.id,$1,NOT EXISTS(SELECT 1 FROM %s t WHERE t.workspace_id=w.id) FROM workspaces w
   ON CONFLICT(workspace_id,relation) DO NOTHING',relation) USING relation;
 END LOOP;
END $$;
