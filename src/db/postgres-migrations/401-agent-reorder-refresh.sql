CREATE TABLE stockchief_runtime.agent_reorder_refresh_rules (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 authorized_by text REFERENCES users(id) ON DELETE SET NULL,
 max_change_percent integer NOT NULL CHECK(max_change_percent BETWEEN 1 AND 500),
 fill_missing boolean NOT NULL DEFAULT false,
 enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_reorder_refresh_rule_owner ON stockchief_runtime.agent_reorder_refresh_rules(authorized_by) WHERE authorized_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_reorder_locks (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
 location_id text REFERENCES locations(id) ON DELETE CASCADE,
 locked_by text REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agent_reorder_lock_position ON stockchief_runtime.agent_reorder_locks(workspace_id,sku_id,(coalesce(location_id,'')));
CREATE INDEX agent_reorder_lock_sku ON stockchief_runtime.agent_reorder_locks(sku_id);
CREATE INDEX agent_reorder_lock_location ON stockchief_runtime.agent_reorder_locks(location_id) WHERE location_id IS NOT NULL;
CREATE INDEX agent_reorder_lock_user ON stockchief_runtime.agent_reorder_locks(locked_by) WHERE locked_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_reorder_refresh_runs (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 run_key text NOT NULL,
 business_date date NOT NULL,
 plan text NOT NULL,
 requested_by text REFERENCES users(id) ON DELETE SET NULL,
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 counts jsonb NOT NULL DEFAULT '{}'::jsonb,
 UNIQUE(workspace_id,run_key)
);
CREATE INDEX agent_reorder_refresh_run_recent ON stockchief_runtime.agent_reorder_refresh_runs(workspace_id,started_at DESC,id);
CREATE INDEX agent_reorder_refresh_run_requester ON stockchief_runtime.agent_reorder_refresh_runs(requested_by) WHERE requested_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_reorder_refresh_changes (
 id text PRIMARY KEY,
 run_id text NOT NULL REFERENCES stockchief_runtime.agent_reorder_refresh_runs(id) ON DELETE CASCADE,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
 location_id text REFERENCES locations(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('SUGGESTED','WATCHED','DRAFT','APPLIED','DECLINED','UNDONE','REPLACED','SKIPPED')),
 reason text,
 before_minimum numeric(20,6),
 before_maximum numeric(20,6),
 before_source text,
 after_minimum numeric(20,6),
 after_maximum numeric(20,6),
 change_percent numeric(12,2),
 value_key text,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 authority text CHECK(authority IN ('RULE','LEARNED','PERSON')),
 rule_revision integer,
 policy_id text REFERENCES reorder_policies(id) ON DELETE SET NULL,
 created_policy boolean NOT NULL DEFAULT false,
 decided_by text REFERENCES users(id) ON DELETE SET NULL,
 decided_at timestamptz,
 undone_by text REFERENCES users(id) ON DELETE SET NULL,
 undone_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status='APPLIED' OR status='UNDONE')=(authority IS NOT NULL)),
 CHECK((status='UNDONE')=(undone_at IS NOT NULL))
);
CREATE UNIQUE INDEX agent_reorder_refresh_change_position ON stockchief_runtime.agent_reorder_refresh_changes(run_id,sku_id,(coalesce(location_id,'')));
CREATE INDEX agent_reorder_refresh_change_open ON stockchief_runtime.agent_reorder_refresh_changes(workspace_id,status,created_at DESC,id);
CREATE INDEX agent_reorder_refresh_change_history ON stockchief_runtime.agent_reorder_refresh_changes(workspace_id,sku_id,location_id,created_at DESC);
CREATE INDEX agent_reorder_refresh_change_sku ON stockchief_runtime.agent_reorder_refresh_changes(sku_id);
CREATE INDEX agent_reorder_refresh_change_location ON stockchief_runtime.agent_reorder_refresh_changes(location_id) WHERE location_id IS NOT NULL;
CREATE INDEX agent_reorder_refresh_change_policy ON stockchief_runtime.agent_reorder_refresh_changes(policy_id) WHERE policy_id IS NOT NULL;
CREATE INDEX agent_reorder_refresh_change_decider ON stockchief_runtime.agent_reorder_refresh_changes(decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX agent_reorder_refresh_change_undoer ON stockchief_runtime.agent_reorder_refresh_changes(undone_by) WHERE undone_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_reorder_refresh_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_reorder_locks'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_reorder_refresh_runs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_reorder_refresh_changes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_reorder_refresh_rules'::regclass,'stockchief_runtime.agent_reorder_locks'::regclass,
  'stockchief_runtime.agent_reorder_refresh_runs'::regclass,'stockchief_runtime.agent_reorder_refresh_changes'::regclass);

-- Reorder changes waiting for a person appear in Needs You. Add job 21 to
-- whatever job list the notice table allows at this point.
DO $$
DECLARE allowed text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO allowed FROM pg_constraint
  WHERE conname='agent_operational_notices_job_id_check' AND conrelid='stockchief_runtime.agent_operational_notices'::regclass;
 IF allowed IS NULL OR position('ARRAY[' IN allowed)=0 THEN
  RAISE EXCEPTION 'The agent notice job list has an unexpected form.';
 END IF;
 IF allowed !~ '\m21\M' THEN
  EXECUTE 'ALTER TABLE stockchief_runtime.agent_operational_notices DROP CONSTRAINT agent_operational_notices_job_id_check, ADD CONSTRAINT agent_operational_notices_job_id_check '
   || replace(allowed,'ARRAY[','ARRAY[21, ');
 END IF;
END $$;
