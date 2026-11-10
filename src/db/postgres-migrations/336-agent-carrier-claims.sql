CREATE TABLE stockchief_runtime.agent_carrier_claims (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  shipment_id text NOT NULL,
  parcel_id text NOT NULL,
  connector_id text NOT NULL,
  scope_key text NOT NULL,
  opened_by text NOT NULL,
  facts jsonb NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  invoice bytea NOT NULL,
  correspondence bytea NOT NULL,
  supporting bytea,
  effect_id text,
  automatic boolean NOT NULL DEFAULT false,
  rule_revision integer,
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,parcel_id),
  UNIQUE(workspace_id,effect_id),
  CHECK (octet_length(invoice) BETWEEN 1 AND 1572864),
  CHECK (octet_length(correspondence) BETWEEN 1 AND 1572864),
  CHECK (supporting IS NULL OR octet_length(supporting) BETWEEN 1 AND 1572864)
);
CREATE INDEX agent_carrier_claims_recent ON stockchief_runtime.agent_carrier_claims(workspace_id,created_at DESC,id DESC);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_carrier_claims'::regclass,
  'octet_length(t.invoice)+octet_length(t.correspondence)+COALESCE(octet_length(t.supporting),0)+octet_length(convert_to((to_jsonb(t)-ARRAY[''invoice'',''correspondence'',''supporting''])::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_carrier_claims'::regclass,true FROM workspaces;
