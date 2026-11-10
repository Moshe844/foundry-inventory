CREATE TABLE stockchief_runtime.agent_freight_pickups (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shipment_id text NOT NULL REFERENCES sales_shipments(id) ON DELETE CASCADE,
  id text NOT NULL,
  connector_id text NOT NULL,
  account_fingerprint text NOT NULL,
  source_fingerprint text NOT NULL,
  facts jsonb NOT NULL,
  offers jsonb NOT NULL,
  approved_offer jsonb,
  receipt jsonb,
  effect_id text,
  revision integer NOT NULL DEFAULT 1,
  rule_revision integer,
  opened_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,shipment_id),
  UNIQUE(workspace_id,effect_id)
);
CREATE INDEX agent_freight_pickups_recent ON stockchief_runtime.agent_freight_pickups(workspace_id,created_at DESC,id DESC);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_freight_pickups'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_freight_pickups'::regclass,true FROM workspaces;
