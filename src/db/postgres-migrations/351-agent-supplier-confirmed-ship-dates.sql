ALTER TABLE stockchief_runtime.supplier_link_submissions
  ADD COLUMN ship_date date,
  ADD COLUMN availability_generation text,
  ADD CONSTRAINT supplier_link_ship_date_confirmation CHECK (ship_date IS NULL OR kind='confirm');

UPDATE commercial_storage_tables SET bytes_expression=replace(bytes_expression,'to_jsonb(t)',
  '(CASE WHEN t.ship_date IS NULL AND t.availability_generation IS NULL THEN to_jsonb(t)-ARRAY[''ship_date'',''availability_generation'']::text[] ELSE to_jsonb(t) END)')
WHERE relation='stockchief_runtime.supplier_link_submissions'::regclass;

CREATE TABLE stockchief_runtime.agent_supplier_ship_promises (
  source_id text PRIMARY KEY REFERENCES stockchief_runtime.supplier_link_submissions(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  purchase_order_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  training_connector_id text REFERENCES workspace_connectors(id) ON DELETE SET NULL,
  training_mailbox_account text,
  ship_date date NOT NULL,
  reported_at timestamptz NOT NULL,
  source_fingerprint text NOT NULL,
  automatic boolean NOT NULL DEFAULT false,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX supplier_ship_promise_latest ON stockchief_runtime.agent_supplier_ship_promises(workspace_id,purchase_order_id,reported_at DESC,source_id);
CREATE INDEX supplier_ship_promise_actor ON stockchief_runtime.agent_supplier_ship_promises(actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX supplier_ship_promise_training_connector ON stockchief_runtime.agent_supplier_ship_promises(training_connector_id) WHERE training_connector_id IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_supplier_confirmation_rules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  authorized_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient text NOT NULL,
  mailbox_account text NOT NULL,
  maximum_messages integer NOT NULL CHECK(maximum_messages BETWEEN 1 AND 5),
  interval_hours integer NOT NULL CHECK(interval_hours BETWEEN 24 AND 720),
  maximum_ship_days integer NOT NULL CHECK(maximum_ship_days BETWEEN 0 AND 365),
  example_source_id text REFERENCES stockchief_runtime.agent_supplier_ship_promises(source_id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,supplier_id)
);
CREATE INDEX supplier_confirmation_rule_connector ON stockchief_runtime.agent_supplier_confirmation_rules(connector_id);
CREATE INDEX supplier_confirmation_rule_supplier ON stockchief_runtime.agent_supplier_confirmation_rules(supplier_id);
CREATE INDEX supplier_confirmation_rule_owner ON stockchief_runtime.agent_supplier_confirmation_rules(authorized_by);
CREATE INDEX supplier_confirmation_rule_example ON stockchief_runtime.agent_supplier_confirmation_rules(example_source_id) WHERE example_source_id IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_supplier_ship_promises'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_confirmation_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_supplier_ship_promises'::regclass,
 'stockchief_runtime.agent_supplier_confirmation_rules'::regclass]) r;
