-- Retain one specifically approved supplier question and reply per rule.
CREATE TABLE stockchief_runtime.agent_supplier_reply_rules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
  mailbox_account text NOT NULL,
  recipient text NOT NULL,
  example_id text NOT NULL REFERENCES connection_email_messages(id) ON DELETE CASCADE,
  approved_by text NOT NULL REFERENCES users(id),
  signature text NOT NULL CHECK (length(signature)=64),
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,supplier_id,connector_id,mailbox_account,recipient,signature)
);
CREATE INDEX agent_supplier_reply_rule_supplier ON stockchief_runtime.agent_supplier_reply_rules(supplier_id);
CREATE INDEX agent_supplier_reply_rule_connector ON stockchief_runtime.agent_supplier_reply_rules(connector_id);
CREATE INDEX agent_supplier_reply_rule_example ON stockchief_runtime.agent_supplier_reply_rules(example_id);
CREATE INDEX agent_supplier_reply_rule_owner ON stockchief_runtime.agent_supplier_reply_rules(approved_by);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_supplier_reply_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.agent_supplier_reply_rules'::regclass,true FROM workspaces;
