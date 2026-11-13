-- Job 202: each vacation the owner schedules, and the approvals StockChief
-- sent to the deputy during it, so the owner gets a hand-back on return:
-- what the deputy decided and what is back with the owner.
CREATE TABLE stockchief_runtime.vacation_coverages (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 revision integer NOT NULL,
 deputy_id text REFERENCES users(id) ON DELETE SET NULL,
 deputy_name text NOT NULL CHECK (length(deputy_name) BETWEEN 1 AND 200),
 starts_on date NOT NULL,
 ends_on date NOT NULL CHECK (ends_on>=starts_on),
 ended_on date,
 handed_back_at timestamptz,
 handed_back_by text REFERENCES users(id) ON DELETE SET NULL,
 PRIMARY KEY (workspace_id,revision)
);
CREATE INDEX vacation_coverage_handback ON stockchief_runtime.vacation_coverages(workspace_id,revision DESC) WHERE handed_back_at IS NULL;
CREATE TABLE stockchief_runtime.vacation_delegations (
 workspace_id text NOT NULL,
 revision integer NOT NULL,
 request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 200),
 kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 60),
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
 href text NOT NULL CHECK (length(href) BETWEEN 1 AND 300),
 delegated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (workspace_id,revision,request_key),
 FOREIGN KEY (workspace_id,revision) REFERENCES stockchief_runtime.vacation_coverages(workspace_id,revision) ON DELETE CASCADE
);
-- A vacation scheduled before this migration keeps its hand-back.
INSERT INTO stockchief_runtime.vacation_coverages(workspace_id,revision,deputy_id,deputy_name,starts_on,ends_on)
 SELECT d.workspace_id,d.revision,d.deputy_id,u.name,d.starts_on,d.ends_on FROM stockchief_runtime.vacation_deputies d
 JOIN users u ON u.workspace_id=d.workspace_id AND u.id=d.deputy_id WHERE length(u.name) BETWEEN 1 AND 200;
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.vacation_coverages'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.vacation_delegations'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN unnest(ARRAY[
  'stockchief_runtime.vacation_coverages'::regclass,'stockchief_runtime.vacation_delegations'::regclass]) r(relation);
