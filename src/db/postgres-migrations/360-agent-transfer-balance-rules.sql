CREATE TABLE stockchief_runtime.agent_transfer_balance_rules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  source_location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  destination_location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  maximum_quantity numeric NOT NULL CHECK(maximum_quantity>0),
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  owner_account_id text REFERENCES accounts(id) ON DELETE SET NULL,
  taught_proposal_id text,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(source_location_id<>destination_location_id),
  PRIMARY KEY(workspace_id,scope_key)
);
CREATE INDEX agent_transfer_balance_authorizer ON stockchief_runtime.agent_transfer_balance_rules(authorized_by);
CREATE INDEX agent_transfer_balance_owner ON stockchief_runtime.agent_transfer_balance_rules(owner_account_id);
CREATE INDEX agent_transfer_balance_sku ON stockchief_runtime.agent_transfer_balance_rules(sku_id);
CREATE INDEX agent_transfer_balance_source ON stockchief_runtime.agent_transfer_balance_rules(source_location_id);
CREATE INDEX agent_transfer_balance_destination ON stockchief_runtime.agent_transfer_balance_rules(destination_location_id);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_transfer_balance_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_transfer_balance_rules'::regclass,true FROM workspaces;
