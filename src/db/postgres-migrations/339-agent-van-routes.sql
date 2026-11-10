CREATE TABLE stockchief_runtime.agent_van_routes (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  depot_id text NOT NULL,
  delivery_date date NOT NULL,
  fleet_key text NOT NULL,
  facts jsonb NOT NULL,
  manifest jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT','READY','STOPPED')),
  automatic boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id)
);
CREATE INDEX agent_van_routes_recent ON stockchief_runtime.agent_van_routes(workspace_id,delivery_date DESC,id);
CREATE INDEX agent_van_routes_current ON stockchief_runtime.agent_van_routes(workspace_id,depot_id) WHERE status='READY';

CREATE TABLE stockchief_runtime.agent_van_route_rules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  depot_id text NOT NULL,
  fleet_key text NOT NULL,
  authorized_by text NOT NULL,
  example_id text,
  maximum_stops integer NOT NULL CHECK (maximum_stops BETWEEN 1 AND 40),
  enabled boolean NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY(workspace_id,depot_id,fleet_key)
);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_van_routes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_van_route_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables r
 WHERE r.relation IN ('stockchief_runtime.agent_van_routes'::regclass,'stockchief_runtime.agent_van_route_rules'::regclass);
