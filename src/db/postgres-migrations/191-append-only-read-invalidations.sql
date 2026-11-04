-- Business writes append independent invalidations. They never UPDATE the
-- workspace-wide cache revision row, which serialized unrelated stock writes.
CREATE TABLE stockchief_runtime.read_model_changes(
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 business BOOLEAN NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX read_model_changes_workspace ON stockchief_runtime.read_model_changes(workspace_id,id) INCLUDE(business);

CREATE OR REPLACE FUNCTION stockchief_changed_read_model() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO stockchief_runtime.read_model_changes(workspace_id,business)
 SELECT DISTINCT c.workspace_id,TG_TABLE_NAME NOT IN('work_items','workspace_autopilot','attention_items')
 FROM changed_rows c JOIN workspaces w ON w.id=c.workspace_id;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION stockchief_changed_workspace_read_model() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO stockchief_runtime.read_model_changes(workspace_id,business)
 SELECT c.id,true FROM changed_workspaces c JOIN workspaces w ON w.id=c.id;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION stockchief_changed_account_business_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO stockchief_runtime.read_model_changes(workspace_id,business)
 SELECT w.id,true FROM changed_accounts a JOIN previous_accounts p ON p.id=a.id
 JOIN workspaces w ON w.owner_account_id=a.id WHERE a.time_zone IS DISTINCT FROM p.time_zone;
 RETURN NULL;
END $$;
