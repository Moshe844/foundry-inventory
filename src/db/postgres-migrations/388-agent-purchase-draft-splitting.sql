ALTER TABLE purchase_order_lines ADD COLUMN requested_delivery_date date;

CREATE TABLE stockchief_runtime.agent_purchase_split_rules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  strategy text NOT NULL CHECK (strategy IN ('warehouse','delivery-date','budget')),
  location_ids text[] NOT NULL CHECK (cardinality(location_ids)>0),
  maximum_source_minor bigint NOT NULL CHECK (maximum_source_minor>0),
  budget_minor bigint CHECK (budget_minor>0),
  training_proposal text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((strategy='budget')=(budget_minor IS NOT NULL)),
  UNIQUE(workspace_id,supplier_id,currency,strategy)
);

CREATE INDEX agent_purchase_split_workspace ON stockchief_runtime.agent_purchase_split_rules(workspace_id,id);
