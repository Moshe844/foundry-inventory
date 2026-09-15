/*
 * Mission 12 — Autonomous supplier manager.
 *
 * Supplier messages are evidence, never commands.  Facts below are immutable
 * observations tied to the exact source document.  Response plans and drafts
 * are advisory coordination records; purchase orders, stock, AP and outbound
 * email remain owned by their existing deterministic domain services.
 */

CREATE TABLE IF NOT EXISTS supplier_operational_facts (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id           TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  purchase_order_id     TEXT REFERENCES purchase_orders(id) ON DELETE SET NULL,
  purchase_order_line_id TEXT REFERENCES purchase_order_lines(id) ON DELETE SET NULL,
  sku_id                TEXT REFERENCES skus(id) ON DELETE SET NULL,
  related_supplier_id   TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  related_sku_id        TEXT REFERENCES skus(id) ON DELETE SET NULL,
  fact_kind             TEXT NOT NULL CHECK (fact_kind IN
    ('OFFER','CAPACITY','CONSTRAINT','SUBSTITUTION','ACKNOWLEDGEMENT','SHIPMENT',
     'PRICE','DATE','DEPOSIT','CREDIT','DISPUTE')),
  fact_key              TEXT NOT NULL,
  value                 TEXT NOT NULL DEFAULT '{}',
  source_document_id    TEXT NOT NULL REFERENCES supplier_documents(id) ON DELETE CASCADE,
  confidence            REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  observed_at           TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  UNIQUE (workspace_id, source_document_id, fact_key)
);
CREATE INDEX IF NOT EXISTS idx_supplier_operational_facts_subject
  ON supplier_operational_facts(workspace_id, supplier_id, sku_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS supplier_response_plans (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id           TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  purchase_order_id     TEXT REFERENCES purchase_orders(id) ON DELETE SET NULL,
  purchase_order_line_id TEXT REFERENCES purchase_order_lines(id) ON DELETE SET NULL,
  sku_id                TEXT REFERENCES skus(id) ON DELETE SET NULL,
  source_document_id    TEXT NOT NULL REFERENCES supplier_documents(id) ON DELETE CASCADE,
  summary               TEXT NOT NULL,
  consequences          TEXT NOT NULL DEFAULT '{}',
  alternatives          TEXT NOT NULL DEFAULT '[]',
  chosen_plan           TEXT NOT NULL DEFAULT '{}',
  evidence              TEXT NOT NULL DEFAULT '[]',
  materiality           TEXT NOT NULL CHECK (materiality IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status                TEXT NOT NULL CHECK (status IN
    ('SHADOW','NEEDS_APPROVAL','DRAFTED','APPROVED','RESOLVED','SUPERSEDED')),
  expected_outcome      TEXT NOT NULL DEFAULT '{}',
  actual_outcome        TEXT NOT NULL DEFAULT '{}',
  requires_purchasing_authority INTEGER NOT NULL DEFAULT 0 CHECK (requires_purchasing_authority IN (0,1)),
  requires_communication_authority INTEGER NOT NULL DEFAULT 0 CHECK (requires_communication_authority IN (0,1)),
  idempotency_key       TEXT NOT NULL,
  decided_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at            TEXT,
  verified_at           TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_supplier_response_plans_order
  ON supplier_response_plans(workspace_id, purchase_order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS supplier_response_drafts (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  response_plan_id      TEXT NOT NULL REFERENCES supplier_response_plans(id) ON DELETE CASCADE,
  draft_type            TEXT NOT NULL CHECK (draft_type IN
    ('FOLLOW_UP','NEGOTIATION','ALTERNATE_PO','CUSTOMER_PROMISE','DEPOSIT_PAYMENT','SUPPLIER_CREDIT')),
  supplier_id           TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  purchase_order_id     TEXT REFERENCES purchase_orders(id) ON DELETE SET NULL,
  subject               TEXT,
  body                  TEXT,
  proposed_payload      TEXT NOT NULL DEFAULT '{}',
  required_permission   TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'PREPARED' CHECK (status IN
    ('PREPARED','APPROVED','EXECUTED','DECLINED','SUPERSEDED')),
  source_document_id    TEXT NOT NULL REFERENCES supplier_documents(id) ON DELETE CASCADE,
  approved_by_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at           TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (workspace_id, response_plan_id, draft_type)
);

CREATE TABLE IF NOT EXISTS supplier_scorecards (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_id           TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  as_of                 TEXT NOT NULL,
  metrics               TEXT NOT NULL,
  evidence              TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  UNIQUE (workspace_id, supplier_id, as_of)
);
CREATE INDEX IF NOT EXISTS idx_supplier_scorecards_supplier
  ON supplier_scorecards(workspace_id, supplier_id, as_of DESC);
