-- Job 177: staff tasks of every main kind, checked against the real records.
--
-- A task points at one piece of native work that already exists: a count
-- assignment, a pick wave, a put-away sheet, a delivery held for inspection
-- or a bin move. It is done only when that record says so (the count saved,
-- the wave scanned, the put-away confirmed, the inspection recorded, the move
-- scanned), never because someone ticked a box.
CREATE TABLE stockchief_runtime.agent_staff_tasks (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('count','pick','putaway','inspect','move')),
 source_id text NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 300),
 location_ids text[] NOT NULL DEFAULT '{}',
 assignee_id text NOT NULL REFERENCES users(id),
 status text NOT NULL CHECK(status IN ('DRAFT','ASSIGNED','DONE','CANCELLED')),
 automatic boolean NOT NULL DEFAULT false,
 due_at timestamptz NOT NULL,
 created_by text REFERENCES users(id),
 approved_by text REFERENCES users(id),
 approved_at timestamptz,
 done_at timestamptz,
 done_by text REFERENCES users(id),
 evidence jsonb,
 closed_reason text CHECK(closed_reason IS NULL OR length(closed_reason)<=500),
 -- The owner who declined or withdrew it. StockChief never hands that work
 -- out again on its own; the owner can still assign it.
 closed_by text REFERENCES users(id),
 overdue_at timestamptz,
 request_key text,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,request_key),
 CHECK((status='DONE')=(done_at IS NOT NULL)),
 CHECK(status<>'ASSIGNED' OR automatic OR approved_by IS NOT NULL)
);
-- One live task per piece of work.
CREATE UNIQUE INDEX agent_staff_task_live ON stockchief_runtime.agent_staff_tasks(workspace_id,kind,source_id) WHERE status IN ('DRAFT','ASSIGNED','DONE');
CREATE INDEX agent_staff_task_source ON stockchief_runtime.agent_staff_tasks(workspace_id,kind,source_id);
CREATE INDEX agent_staff_task_open ON stockchief_runtime.agent_staff_tasks(workspace_id,status,due_at) WHERE status IN ('DRAFT','ASSIGNED');
CREATE INDEX agent_staff_task_list ON stockchief_runtime.agent_staff_tasks(workspace_id,created_at DESC,id DESC);
CREATE INDEX agent_staff_task_done ON stockchief_runtime.agent_staff_tasks(workspace_id,done_at) WHERE status='DONE';
CREATE INDEX agent_staff_task_assignee ON stockchief_runtime.agent_staff_tasks(assignee_id,status);
CREATE INDEX agent_staff_task_creator ON stockchief_runtime.agent_staff_tasks(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX agent_staff_task_approver ON stockchief_runtime.agent_staff_tasks(approved_by) WHERE approved_by IS NOT NULL;
CREATE INDEX agent_staff_task_finisher ON stockchief_runtime.agent_staff_tasks(done_by) WHERE done_by IS NOT NULL;
CREATE INDEX agent_staff_task_closer ON stockchief_runtime.agent_staff_tasks(closed_by) WHERE closed_by IS NOT NULL;

-- The owner's limits for handing out work: which kinds StockChief may give
-- out, how long staff have, and how many open tasks one person may hold.
CREATE TABLE stockchief_runtime.agent_staff_task_rules (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 kinds text[] NOT NULL CHECK(cardinality(kinds) BETWEEN 1 AND 5 AND kinds <@ ARRAY['count','pick','putaway','inspect','move']),
 due_hours integer NOT NULL CHECK(due_hours BETWEEN 1 AND 168),
 max_open integer NOT NULL CHECK(max_open BETWEEN 1 AND 50),
 enabled boolean NOT NULL DEFAULT true,
 authorized_by text NOT NULL REFERENCES users(id),
 last_issue text CHECK(last_issue IS NULL OR length(last_issue)<=500),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_staff_task_rule_owner ON stockchief_runtime.agent_staff_task_rules(authorized_by);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_staff_tasks'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_staff_task_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_staff_tasks'::regclass,'stockchief_runtime.agent_staff_task_rules'::regclass]) r;
