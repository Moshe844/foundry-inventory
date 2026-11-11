CREATE TABLE stockchief_runtime.agent_supplier_delivery_chase_rules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  authorized_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient text NOT NULL,
  mailbox_account text NOT NULL,
  maximum_messages integer NOT NULL CHECK(maximum_messages BETWEEN 1 AND 5),
  interval_hours integer NOT NULL CHECK(interval_hours BETWEEN 24 AND 720),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,supplier_id)
);
CREATE INDEX agent_delivery_chase_connector ON stockchief_runtime.agent_supplier_delivery_chase_rules(connector_id);
CREATE INDEX agent_delivery_chase_supplier ON stockchief_runtime.agent_supplier_delivery_chase_rules(supplier_id);
CREATE INDEX agent_delivery_chase_owner ON stockchief_runtime.agent_supplier_delivery_chase_rules(authorized_by);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_supplier_delivery_chase_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_supplier_delivery_chase_rules'::regclass,true FROM workspaces;

DO $$
DECLARE previous text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint
 WHERE conrelid='stockchief_runtime.agent_time_samples'::regclass AND conname='agent_time_samples_activity_check';
 ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
 EXECUTE 'ALTER TABLE stockchief_runtime.agent_time_samples ADD CONSTRAINT agent_time_samples_activity_check CHECK (('||previous||') OR activity=''supplier-delivery-followup'')';
END $$;
