-- Job 49: a freight, duty or fee bill posted for a recorded delivery updates
-- the delivered goods' cost through the existing landed-cost allocation.

-- What the bill line covers, when the person or document says so.
ALTER TABLE accounting_supplier_bill_lines ADD COLUMN landed_cost_kind text
  CHECK (landed_cost_kind IN ('freight','duty','insurance','handling'));
CREATE INDEX agent_landed_cost_bill_kind ON accounting_supplier_bill_lines(workspace_id,bill_id) WHERE landed_cost_kind IS NOT NULL;
CREATE INDEX agent_landed_cost_bill_delivery ON accounting_supplier_bills(workspace_id,created_at) WHERE purchase_receipt_id IS NOT NULL;

-- Which allocations StockChief posted on its own. Older rows stay unknown (NULL)
-- and never count as a person's approved example.
ALTER TABLE landed_cost_documents ADD COLUMN applied_automatically boolean;

-- The owner's limit for one supplier or carrier and one cost type.
CREATE TABLE stockchief_runtime.agent_landed_cost_rules (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('freight','duty','insurance','handling')),
  enabled boolean NOT NULL DEFAULT true,
  currency text NOT NULL,
  maximum_minor bigint NOT NULL CHECK (maximum_minor>0),
  method text NOT NULL CHECK (method IN ('quantity','value','weight')),
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  example_document_id text REFERENCES landed_cost_documents(id) ON DELETE SET NULL,
  revision int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,supplier_id,category)
);
CREATE INDEX agent_landed_cost_rule_supplier ON stockchief_runtime.agent_landed_cost_rules(supplier_id);
CREATE INDEX agent_landed_cost_rule_owner ON stockchief_runtime.agent_landed_cost_rules(authorized_by) WHERE authorized_by IS NOT NULL;
CREATE INDEX agent_landed_cost_rule_example ON stockchief_runtime.agent_landed_cost_rules(example_document_id) WHERE example_document_id IS NOT NULL;

-- One row per posted bill line that is a cost of a delivery: what StockChief did with it.
CREATE TABLE stockchief_runtime.agent_landed_cost_bills (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bill_line_id text NOT NULL REFERENCES accounting_supplier_bill_lines(id) ON DELETE CASCADE,
  bill_id text NOT NULL REFERENCES accounting_supplier_bills(id) ON DELETE CASCADE,
  supplier_id text REFERENCES suppliers(id) ON DELETE SET NULL,
  receipt_id text REFERENCES purchase_order_receipts(id) ON DELETE SET NULL,
  category text CHECK (category IN ('freight','duty','insurance','handling')),
  method text CHECK (method IN ('quantity','value','weight')),
  chosen_by text REFERENCES users(id) ON DELETE SET NULL,
  currency text,
  amount_minor bigint CHECK (amount_minor>=0),
  status text NOT NULL CHECK (status IN ('WATCHING','REVIEW','HELD','POSTED','KEPT','UNDONE','HANDLED')),
  reason text,
  would_post boolean NOT NULL DEFAULT false,
  automatic boolean NOT NULL DEFAULT false,
  document_id text REFERENCES landed_cost_documents(id) ON DELETE SET NULL,
  attempt int NOT NULL DEFAULT 1 CHECK (attempt>0),
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  rule_revision int,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  PRIMARY KEY (workspace_id,bill_line_id),
  CHECK (status NOT IN ('POSTED','UNDONE') OR document_id IS NOT NULL)
);
CREATE INDEX agent_landed_cost_bills_waiting ON stockchief_runtime.agent_landed_cost_bills(workspace_id,checked_at)
  WHERE status IN ('WATCHING','REVIEW','HELD');
CREATE INDEX agent_landed_cost_bills_recent ON stockchief_runtime.agent_landed_cost_bills(workspace_id,created_at DESC,bill_line_id);
CREATE INDEX agent_landed_cost_bills_bill ON stockchief_runtime.agent_landed_cost_bills(bill_id);
CREATE INDEX agent_landed_cost_bills_line ON stockchief_runtime.agent_landed_cost_bills(bill_line_id);
CREATE INDEX agent_landed_cost_bills_supplier ON stockchief_runtime.agent_landed_cost_bills(supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX agent_landed_cost_bills_receipt ON stockchief_runtime.agent_landed_cost_bills(receipt_id) WHERE receipt_id IS NOT NULL;
CREATE INDEX agent_landed_cost_bills_document ON stockchief_runtime.agent_landed_cost_bills(document_id) WHERE document_id IS NOT NULL;
CREATE INDEX agent_landed_cost_bills_chosen ON stockchief_runtime.agent_landed_cost_bills(chosen_by) WHERE chosen_by IS NOT NULL;
CREATE INDEX agent_landed_cost_bills_person ON stockchief_runtime.agent_landed_cost_bills(decided_by) WHERE decided_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_landed_cost_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_landed_cost_bills'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
  WHERE t.relation IN ('stockchief_runtime.agent_landed_cost_rules'::regclass,'stockchief_runtime.agent_landed_cost_bills'::regclass);
