-- Mission 2: one immutable chain of evidence from operational cause to outcome.
--
-- Endpoints are polymorphic because the facts live in their owning domain
-- tables.  The service registry validates both endpoint types, both records,
-- workspace isolation, and the allowed direction before anything is inserted.
-- This table is an index over business truth; it is not a second copy of it.
CREATE TABLE IF NOT EXISTS business_relations (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  relation_key        TEXT NOT NULL,
  relation_type       TEXT NOT NULL CHECK (relation_type IN
                        ('HAS_PART','HAS_EVENT','EMITTED_EVENT','CREATED_FROM','EVIDENCED_BY',
                         'DECIDED_BY','RESPONDS_TO','RECEIVED_AS','CAUSED_MOVEMENT','FULFILLED_BY',
                         'BILLED_BY','PAID_BY','POSTED_AS','EXECUTED_AS','VERIFIED_BY','CAPITALIZES_COST_OF',
                         'RETURN_OF','RESOLVED_BY')),
  from_type           TEXT NOT NULL CHECK (from_type IN
                        ('domain_event','sales_order','sales_order_line','sales_order_event',
                         'purchase_order','purchase_order_line','purchase_receipt','purchase_receipt_line',
                         'purchase_order_event','inventory_movement','supplier_document','email_message',
                         'supplier_bill','supplier_bill_line','customer_invoice','customer_invoice_line',
                         'payment','journal_entry','attention_item','planning_recommendation','work_item',
                         'action_proposal','action_execution','action_verification','shipment','landed_cost_document',
                         'inventory_transfer','inventory_transfer_line','inventory_transfer_event','count_campaign','count_session','count_line',
                         'customer_return','customer_return_line','supplier_return','supplier_return_line','sale_refund','supplier_credit',
                         'fulfillment_wave','fulfillment_wave_line')),
  from_id             TEXT NOT NULL,
  to_type             TEXT NOT NULL CHECK (to_type IN
                        ('domain_event','sales_order','sales_order_line','sales_order_event',
                         'purchase_order','purchase_order_line','purchase_receipt','purchase_receipt_line',
                         'purchase_order_event','inventory_movement','supplier_document','email_message',
                         'supplier_bill','supplier_bill_line','customer_invoice','customer_invoice_line',
                         'payment','journal_entry','attention_item','planning_recommendation','work_item',
                         'action_proposal','action_execution','action_verification','shipment','landed_cost_document',
                         'inventory_transfer','inventory_transfer_line','inventory_transfer_event','count_campaign','count_session','count_line',
                         'customer_return','customer_return_line','supplier_return','supplier_return_line','sale_refund','supplier_credit',
                         'fulfillment_wave','fulfillment_wave_line')),
  to_id               TEXT NOT NULL,
  evidence_type       TEXT,
  evidence_id         TEXT,
  domain_event_id     TEXT REFERENCES domain_events(id) ON DELETE RESTRICT,
  basis               TEXT NOT NULL CHECK (basis IN ('EVENT','DIRECT_RECORD','BACKFILL')),
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  UNIQUE (workspace_id, relation_key),
  CHECK ((evidence_type IS NULL AND evidence_id IS NULL)
      OR (evidence_type IS NOT NULL AND evidence_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_business_relations_from
  ON business_relations(workspace_id, from_type, from_id, created_at);
CREATE INDEX IF NOT EXISTS idx_business_relations_to
  ON business_relations(workspace_id, to_type, to_id, created_at);
CREATE INDEX IF NOT EXISTS idx_business_relations_event
  ON business_relations(workspace_id, domain_event_id)
  WHERE domain_event_id IS NOT NULL;

-- A discovered relation is historical evidence. Corrections add a new record;
-- they never rewrite the old chain.
CREATE TRIGGER IF NOT EXISTS trg_business_relations_no_update
BEFORE UPDATE ON business_relations
BEGIN
  SELECT RAISE(ABORT, 'business relations are immutable; add a correcting relation');
END;

CREATE TRIGGER IF NOT EXISTS trg_business_relations_no_delete
BEFORE DELETE ON business_relations
BEGIN
  SELECT RAISE(ABORT, 'business relations cannot be deleted');
END;
