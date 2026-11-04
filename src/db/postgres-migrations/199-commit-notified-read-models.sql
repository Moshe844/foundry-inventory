-- Delivered only after COMMIT, coalesced per workspace/payload by PostgreSQL.
-- Readers retain their bounded TTL if a notification connection is interrupted.
CREATE OR REPLACE FUNCTION stockchief_changed_read_model() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('stockchief_read_models',json_build_object('workspace',c.workspace_id,'business',TG_TABLE_NAME NOT IN('work_items','workspace_autopilot','attention_items'))::text)
 FROM (SELECT DISTINCT workspace_id FROM changed_rows) c JOIN workspaces w ON w.id=c.workspace_id;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION stockchief_changed_workspace_read_model() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('stockchief_read_models',json_build_object('workspace',c.id,'business',true)::text)
 FROM changed_workspaces c JOIN workspaces w ON w.id=c.id;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION stockchief_changed_account_business_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('stockchief_read_models',json_build_object('workspace',w.id,'business',true)::text)
 FROM changed_accounts a JOIN previous_accounts p ON p.id=a.id
 JOIN workspaces w ON w.owner_account_id=a.id WHERE a.time_zone IS DISTINCT FROM p.time_zone;
 RETURN NULL;
END $$;
DROP TABLE stockchief_runtime.read_model_changes;
-- A zero-row, updatable compatibility view keeps a draining old web/worker
-- from failing during a rolling deployment. It stores no invalidations.
-- Retire this view only after both services are live on the new source.
CREATE VIEW stockchief_runtime.read_model_changes AS
 SELECT revision AS id,workspace_id,true AS business
 FROM stockchief_runtime.read_model_versions WHERE false;
