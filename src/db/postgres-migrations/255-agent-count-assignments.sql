CREATE TABLE stockchief_runtime.agent_count_schedules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  location_id text NOT NULL REFERENCES locations(id),
  counter_id text NOT NULL REFERENCES users(id),
  owner_id text NOT NULL REFERENCES users(id),
  interval_days integer NOT NULL CHECK(interval_days BETWEEN 1 AND 366),
  next_due date NOT NULL,
  last_issue text,
  PRIMARY KEY(workspace_id,location_id)
);
CREATE TABLE stockchief_runtime.agent_count_tasks (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id text NOT NULL,
  location_id text NOT NULL REFERENCES locations(id),
  counter_id text NOT NULL REFERENCES users(id),
  request_key text NOT NULL,
  observed_at timestamptz,
  PRIMARY KEY(workspace_id,campaign_id),
  UNIQUE(workspace_id,request_key),
  FOREIGN KEY(workspace_id,campaign_id) REFERENCES warehouse_count_campaigns(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE warehouse_count_campaign_lines ADD COLUMN counter_quantity numeric CHECK(counter_quantity>=0);
CREATE INDEX agent_count_tasks_counter ON stockchief_runtime.agent_count_tasks(workspace_id,counter_id) WHERE observed_at IS NULL;
INSERT INTO commercial_storage_tables(relation,bytes_expression)
SELECT relation_name::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'
FROM unnest(ARRAY['stockchief_runtime.agent_count_schedules','stockchief_runtime.agent_count_tasks']) registered(relation_name);
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
SELECT w.id,registered.relation_name::regclass,true FROM workspaces w CROSS JOIN
unnest(ARRAY['stockchief_runtime.agent_count_schedules','stockchief_runtime.agent_count_tasks']) registered(relation_name);
