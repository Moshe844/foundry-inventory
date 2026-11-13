CREATE TABLE stockchief_runtime.agent_supplier_date_request_rules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  authorized_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient text NOT NULL,
  mailbox_account text NOT NULL,
  example_id text REFERENCES supplier_communications(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  UNIQUE(workspace_id,supplier_id)
);
CREATE INDEX agent_supplier_date_requests_connector ON stockchief_runtime.agent_supplier_date_request_rules(connector_id);
CREATE INDEX agent_supplier_date_requests_owner ON stockchief_runtime.agent_supplier_date_request_rules(authorized_by);
CREATE INDEX agent_supplier_date_requests_supplier ON stockchief_runtime.agent_supplier_date_request_rules(supplier_id);
CREATE INDEX agent_supplier_date_requests_example ON stockchief_runtime.agent_supplier_date_request_rules(example_id) WHERE example_id IS NOT NULL;
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_supplier_date_request_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_supplier_date_request_rules'::regclass,true FROM workspaces;
