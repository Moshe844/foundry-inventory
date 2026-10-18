-- Versioned policies are distinct from immutable transaction pricing.
CREATE TABLE stockchief_runtime.pricing_rules (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 revision INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id)
);
CREATE TABLE stockchief_runtime.pricing_rule_versions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, rule_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), definition JSONB NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,rule_id) REFERENCES stockchief_runtime.pricing_rules(workspace_id,id),
 UNIQUE(workspace_id,rule_id,revision)
);
CREATE TABLE stockchief_runtime.pricing_proposals (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 rule_id TEXT NOT NULL, expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
 definition JSONB NOT NULL, integrity_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING'
 CHECK(status IN ('PENDING','APPROVED','REJECTED')), created_by TEXT NOT NULL REFERENCES users(id),
 approved_by TEXT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_at TIMESTAMPTZ,
 UNIQUE(workspace_id,id)
);
CREATE TABLE stockchief_runtime.pricing_order_snapshots (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), sales_order_id TEXT NOT NULL REFERENCES sales_orders(id),
 quote JSONB NOT NULL, integrity_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id)
);
CREATE TABLE stockchief_runtime.pricing_redemptions (
 workspace_id TEXT NOT NULL, rule_id TEXT NOT NULL, sales_order_id TEXT NOT NULL REFERENCES sales_orders(id),
 customer_id TEXT NOT NULL REFERENCES customers(id), released_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,rule_id) REFERENCES stockchief_runtime.pricing_rules(workspace_id,id),
 PRIMARY KEY(workspace_id,rule_id,sales_order_id)
);
ALTER TABLE sales_order_lines ADD COLUMN pricing_snapshot JSONB;
ALTER TABLE sales_orders ADD COLUMN pricing_quote_id TEXT;
ALTER TABLE sales_orders ADD FOREIGN KEY(workspace_id,pricing_quote_id)
 REFERENCES stockchief_runtime.pricing_order_snapshots(workspace_id,id);
ALTER TABLE accounting_customer_invoice_lines ADD COLUMN pricing_snapshot JSONB;
CREATE FUNCTION stockchief_runtime.keep_pricing_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Historical pricing is immutable'; END; $$;
CREATE TRIGGER immutable_pricing_version BEFORE UPDATE OR DELETE ON stockchief_runtime.pricing_rule_versions
 FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.keep_pricing_history();
CREATE TRIGGER immutable_order_price BEFORE UPDATE OR DELETE ON stockchief_runtime.pricing_order_snapshots
 FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.keep_pricing_history();
CREATE INDEX pricing_rules_workspace ON stockchief_runtime.pricing_rules(workspace_id);
CREATE INDEX pricing_proposals_workspace ON stockchief_runtime.pricing_proposals(workspace_id,status,created_at);
CREATE TABLE stockchief_runtime.pricing_invoice_snapshots (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),invoice_id TEXT NOT NULL REFERENCES accounting_customer_invoices(id),
 quote JSONB NOT NULL,integrity_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(workspace_id,invoice_id)
);
CREATE TRIGGER immutable_invoice_price BEFORE UPDATE OR DELETE ON stockchief_runtime.pricing_invoice_snapshots FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.keep_pricing_history();
CREATE TABLE stockchief_runtime.pricing_invoice_redemptions (
 workspace_id TEXT NOT NULL,rule_id TEXT NOT NULL,invoice_id TEXT NOT NULL REFERENCES accounting_customer_invoices(id),customer_id TEXT NOT NULL REFERENCES customers(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,rule_id) REFERENCES stockchief_runtime.pricing_rules(workspace_id,id),PRIMARY KEY(workspace_id,rule_id,invoice_id)
);
