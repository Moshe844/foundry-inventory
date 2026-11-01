ALTER TABLE stockchief_runtime.read_model_versions ADD COLUMN business_revision BIGINT NOT NULL DEFAULT 0;
UPDATE stockchief_runtime.read_model_versions SET business_revision=revision;
CREATE OR REPLACE FUNCTION stockchief_changed_read_model() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO stockchief_runtime.read_model_versions(workspace_id,revision,business_revision)
 SELECT DISTINCT c.workspace_id,1,CASE WHEN TG_TABLE_NAME IN('work_items','workspace_autopilot','attention_items') THEN 0 ELSE 1 END
 FROM changed_rows c JOIN workspaces w ON w.id=c.workspace_id ORDER BY c.workspace_id
 ON CONFLICT(workspace_id) DO UPDATE SET revision=read_model_versions.revision+1,business_revision=read_model_versions.business_revision+EXCLUDED.business_revision;
 RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION stockchief_changed_workspace_read_model() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO stockchief_runtime.read_model_versions(workspace_id,revision,business_revision)
 SELECT c.id,1,1 FROM changed_workspaces c JOIN workspaces w ON w.id=c.id ORDER BY c.id
 ON CONFLICT(workspace_id) DO UPDATE SET revision=read_model_versions.revision+1,business_revision=read_model_versions.business_revision+1;
 RETURN NULL;
END;
$$;
CREATE FUNCTION stockchief_changed_account_business_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO stockchief_runtime.read_model_versions(workspace_id,revision,business_revision)
 SELECT w.id,1,1 FROM changed_accounts a JOIN previous_accounts p ON p.id=a.id JOIN workspaces w ON w.owner_account_id=a.id
 WHERE a.time_zone IS DISTINCT FROM p.time_zone ORDER BY w.id
 ON CONFLICT(workspace_id) DO UPDATE SET revision=read_model_versions.revision+1,business_revision=read_model_versions.business_revision+1;
 RETURN NULL;
END;
$$;
CREATE TRIGGER read_model_account_time AFTER UPDATE ON accounts REFERENCING NEW TABLE AS changed_accounts OLD TABLE AS previous_accounts FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_account_business_time();
