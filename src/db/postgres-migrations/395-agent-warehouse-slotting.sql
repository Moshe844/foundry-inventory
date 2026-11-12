CREATE TABLE stockchief_runtime.agent_slotting_capacities (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  primary_limit numeric NOT NULL CHECK(primary_limit>0),
  secondary_limit numeric CHECK(secondary_limit>0),
  profile_hash text NOT NULL,
  revision text NOT NULL,
  recorded_by text REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY(workspace_id,location_id,sku_id)
);
CREATE INDEX agent_slotting_capacities_location ON stockchief_runtime.agent_slotting_capacities(location_id);
CREATE INDEX agent_slotting_capacities_sku ON stockchief_runtime.agent_slotting_capacities(sku_id);

CREATE TABLE stockchief_runtime.agent_slotting_schedules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  warehouse_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  revision text NOT NULL,
  cadence_days integer NOT NULL CHECK(cadence_days IN(1,7)),
  maximum_moves integer NOT NULL CHECK(maximum_moves BETWEEN 1 AND 250),
  maximum_units numeric NOT NULL CHECK(maximum_units>0),
  minimum_visits integer NOT NULL CHECK(minimum_visits>0),
  next_on date NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY(workspace_id,warehouse_id)
);
CREATE INDEX agent_slotting_schedule_warehouse ON stockchief_runtime.agent_slotting_schedules(warehouse_id);

CREATE TABLE stockchief_runtime.agent_slotting_plans (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  warehouse_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  prepared_by text REFERENCES users(id) ON DELETE SET NULL,
  automatic boolean NOT NULL,
  evidence_hash text NOT NULL,
  snapshot jsonb NOT NULL,
  problems jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,warehouse_id,evidence_hash)
);
CREATE INDEX agent_slotting_plan_warehouse ON stockchief_runtime.agent_slotting_plans(warehouse_id);
CREATE INDEX agent_slotting_plans_recent ON stockchief_runtime.agent_slotting_plans(workspace_id,warehouse_id,created_at DESC,id);

CREATE TABLE stockchief_runtime.agent_slotting_moves (
  workspace_id text NOT NULL,
  plan_id text NOT NULL,
  move_hash text NOT NULL,
  transfer_id text NOT NULL REFERENCES inventory_transfers(id) ON DELETE CASCADE,
  approved_by text REFERENCES users(id) ON DELETE SET NULL,
  automatic boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  undone_by text REFERENCES users(id) ON DELETE SET NULL,
  undone_at timestamptz,
  PRIMARY KEY(workspace_id,plan_id,move_hash),
  UNIQUE(transfer_id),
  FOREIGN KEY(workspace_id,plan_id) REFERENCES stockchief_runtime.agent_slotting_plans(workspace_id,id) ON DELETE CASCADE
);

INSERT INTO commercial_storage_tables(relation,bytes_expression)
 SELECT r::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'
 FROM unnest(ARRAY['stockchief_runtime.agent_slotting_capacities','stockchief_runtime.agent_slotting_schedules',
 'stockchief_runtime.agent_slotting_plans','stockchief_runtime.agent_slotting_moves']) r;
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,r::regclass,true FROM workspaces w
 CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_slotting_capacities','stockchief_runtime.agent_slotting_schedules',
 'stockchief_runtime.agent_slotting_plans','stockchief_runtime.agent_slotting_moves']) r;
