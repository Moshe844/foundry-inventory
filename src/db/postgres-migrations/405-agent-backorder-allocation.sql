-- Job 64: the owner's limit for setting stock aside alone, and every
-- allocation StockChief prepared or applied for waiting orders, so each one
-- can be approved, shown in the activity log and undone.
CREATE TABLE stockchief_runtime.agent_backorder_rules (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 authorized_by text REFERENCES users(id) ON DELETE SET NULL,
 max_units integer NOT NULL CHECK(max_units BETWEEN 1 AND 1000000),
 release_ready boolean NOT NULL DEFAULT true,
 enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_backorder_rule_owner ON stockchief_runtime.agent_backorder_rules(authorized_by) WHERE authorized_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_backorder_runs (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 job_id integer NOT NULL CHECK(job_id IN (64,65)),
 location_id text NOT NULL REFERENCES locations(id),
 status text NOT NULL CHECK(status IN ('DRAFT','APPLIED','UNDONE','DISCARDED','STALE')),
 authorization_kind text CHECK(authorization_kind IN ('INDIVIDUAL','AUTOMATIC')),
 plan jsonb NOT NULL,
 fingerprint text NOT NULL,
 rule_revision integer,
 request_key text NOT NULL,
 reason text,
 prepared_by text REFERENCES users(id) ON DELETE SET NULL,
 applied_by text REFERENCES users(id) ON DELETE SET NULL,
 applied_at timestamptz,
 released jsonb,
 release_note text,
 undone_by text REFERENCES users(id) ON DELETE SET NULL,
 undone_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,request_key),
 CHECK((status IN ('APPLIED','UNDONE'))=(applied_at IS NOT NULL AND authorization_kind IS NOT NULL)),
 CHECK((status='UNDONE')=(undone_at IS NOT NULL))
);
CREATE UNIQUE INDEX agent_backorder_run_open_draft ON stockchief_runtime.agent_backorder_runs(workspace_id,job_id,location_id) WHERE status='DRAFT';
CREATE INDEX agent_backorder_run_recent ON stockchief_runtime.agent_backorder_runs(workspace_id,created_at DESC,id);
CREATE INDEX agent_backorder_run_location ON stockchief_runtime.agent_backorder_runs(location_id);
CREATE INDEX agent_backorder_run_preparer ON stockchief_runtime.agent_backorder_runs(prepared_by) WHERE prepared_by IS NOT NULL;
CREATE INDEX agent_backorder_run_applier ON stockchief_runtime.agent_backorder_runs(applied_by) WHERE applied_by IS NOT NULL;
CREATE INDEX agent_backorder_run_undoer ON stockchief_runtime.agent_backorder_runs(undone_by) WHERE undone_by IS NOT NULL;

-- Plans waiting for approval appear in Needs you as soon as they change.
CREATE TRIGGER read_model_insert AFTER INSERT ON stockchief_runtime.agent_backorder_runs REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
CREATE TRIGGER read_model_update AFTER UPDATE ON stockchief_runtime.agent_backorder_runs REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
CREATE TRIGGER read_model_delete AFTER DELETE ON stockchief_runtime.agent_backorder_runs REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_backorder_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_backorder_runs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_backorder_rules'::regclass,'stockchief_runtime.agent_backorder_runs'::regclass);
