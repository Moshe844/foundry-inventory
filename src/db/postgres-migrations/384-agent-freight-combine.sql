CREATE TABLE stockchief_runtime.agent_freight_combine_rules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  maximum_minor bigint NOT NULL CHECK (maximum_minor > 0),
  training_proposal text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,supplier_id,location_id,currency)
);

CREATE INDEX agent_freight_combine_workspace
  ON stockchief_runtime.agent_freight_combine_rules(workspace_id,id);
