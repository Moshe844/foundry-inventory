CREATE TABLE stockchief_runtime.recurring_customer_orders (
 id text NOT NULL,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 authorized_by text NOT NULL REFERENCES users(id),
 customer_id text NOT NULL REFERENCES customers(id),
 template jsonb NOT NULL,
 cadence text NOT NULL CHECK(cadence IN ('daily','weekly','monthly')),
 next_date date NOT NULL,
 anchor_day smallint NOT NULL CHECK(anchor_day BETWEEN 1 AND 31),
 maximum_minor bigint NOT NULL CHECK(maximum_minor>0),
 currency text NOT NULL,
 revision integer NOT NULL DEFAULT 1,
 paused boolean NOT NULL DEFAULT false,
 problem text,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id)
);
CREATE INDEX recurring_customer_order_due ON stockchief_runtime.recurring_customer_orders(workspace_id,next_date,id) WHERE NOT paused;
ALTER TABLE stockchief_runtime.agent_operational_notices DROP CONSTRAINT agent_operational_notices_job_id_check;
ALTER TABLE stockchief_runtime.agent_operational_notices ADD CHECK(job_id IN (67,124,167,168,169,170,171,206));
CREATE TABLE stockchief_runtime.recurring_customer_order_runs (
 workspace_id text NOT NULL,
 schedule_id text NOT NULL,
 scheduled_date date NOT NULL,
 sales_order_id text NOT NULL REFERENCES sales_orders(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,schedule_id,scheduled_date),
 FOREIGN KEY(workspace_id,schedule_id) REFERENCES stockchief_runtime.recurring_customer_orders(workspace_id,id) ON DELETE CASCADE
);
INSERT INTO commercial_storage_tables(relation,bytes_expression)
VALUES('stockchief_runtime.recurring_customer_orders'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.recurring_customer_order_runs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN unnest(ARRAY[
 'stockchief_runtime.recurring_customer_orders'::regclass,'stockchief_runtime.recurring_customer_order_runs'::regclass]) r(relation);
