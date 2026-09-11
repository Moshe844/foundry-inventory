'use strict';

const graph = require('./service');

function json(value, fallback = {}) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function add(db, workspaceId, relation) {
  try {
    graph.record(db, workspaceId, { basis: 'BACKFILL', ...relation });
    return 1;
  } catch (error) {
    // Historical databases can contain a deleted optional source. That is not
    // evidence and therefore does not become a dangling or guessed relation.
    if (error && (error.name === 'NotFoundError' || error.name === 'ValidationError')) return 0;
    throw error;
  }
}

function each(db, sql, args, visit) {
  let count = 0;
  for (const row of db.prepare(sql).all(...args)) count += visit(row) || 0;
  return count;
}

function backfillWorkspace(db, workspaceId) {
  if (!tableExists(db, 'business_relations')) return { recorded: 0 };
  let recorded = 0;
  const link = (relation) => { recorded += add(db, workspaceId, relation); };

  each(db, 'SELECT id, purchase_order_id FROM purchase_order_lines WHERE workspace_id = ?', [workspaceId], (row) =>
    link({ type: 'HAS_PART', from: { type: 'purchase_order', id: row.purchase_order_id }, to: { type: 'purchase_order_line', id: row.id } }));
  each(db, `SELECT id, source_detail FROM purchase_orders WHERE workspace_id = ?`, [workspaceId], (row) => {
    const source = json(row.source_detail, {});
    if (source.workItemId) link({ type: 'DECIDED_BY', from: { type: 'purchase_order', id: row.id }, to: { type: 'work_item', id: source.workItemId } });
    if (source.recommendationId) link({ type: 'DECIDED_BY', from: { type: 'purchase_order', id: row.id }, to: { type: 'planning_recommendation', id: source.recommendationId } });
    if (source.triggerEventId) link({ type: 'RESPONDS_TO', from: { type: 'purchase_order', id: row.id }, to: { type: 'domain_event', id: source.triggerEventId } });
    for (const demand of Array.isArray(source.customerDemand) ? source.customerDemand : []) {
      if (!demand.orderId) continue;
      link({ type: 'RESPONDS_TO', from: { type: 'purchase_order', id: row.id },
        to: { type: 'sales_order', id: demand.orderId }, metadata: {
          skuId: demand.skuId || null,
          displayName: demand.displayName || null,
          waitingQuantity: Number(demand.waitingQuantity || 0),
          orderNumber: demand.orderNumber || null,
          customerName: demand.customerName || null,
        } });
    }
  });
  each(db, 'SELECT id, purchase_order_id FROM purchase_order_receipts WHERE workspace_id = ?', [workspaceId], (row) =>
    link({ type: 'RECEIVED_AS', from: { type: 'purchase_order', id: row.purchase_order_id }, to: { type: 'purchase_receipt', id: row.id } }));
  each(db, `SELECT id, receipt_id, purchase_order_line_id, movement_ids
    FROM purchase_order_receipt_lines WHERE workspace_id = ?`, [workspaceId], (row) => {
    link({ type: 'HAS_PART', from: { type: 'purchase_receipt', id: row.receipt_id }, to: { type: 'purchase_receipt_line', id: row.id } });
    link({ type: 'RECEIVED_AS', from: { type: 'purchase_order_line', id: row.purchase_order_line_id }, to: { type: 'purchase_receipt_line', id: row.id } });
    for (const id of json(row.movement_ids, [])) link({ type: 'CAUSED_MOVEMENT', from: { type: 'purchase_receipt_line', id: row.id }, to: { type: 'inventory_movement', id } });
  });
  each(db, 'SELECT id, purchase_order_id FROM purchase_order_events WHERE workspace_id = ?', [workspaceId], (row) =>
    link({ type: 'HAS_EVENT', from: { type: 'purchase_order', id: row.purchase_order_id }, to: { type: 'purchase_order_event', id: row.id } }));

  each(db, 'SELECT id, sales_order_id FROM sales_order_lines WHERE workspace_id = ?', [workspaceId], (row) =>
    link({ type: 'HAS_PART', from: { type: 'sales_order', id: row.sales_order_id }, to: { type: 'sales_order_line', id: row.id } }));
  each(db, 'SELECT id, sales_order_id, event_type, detail FROM sales_order_events WHERE workspace_id = ?', [workspaceId], (row) => {
    link({ type: 'HAS_EVENT', from: { type: 'sales_order', id: row.sales_order_id }, to: { type: 'sales_order_event', id: row.id } });
    const detail = json(row.detail, {});
    // A reservation recheck records the exact domain event that caused it.
    // Preserve that causal edge for old orders too; a missing trigger remains
    // missing rather than being inferred from timestamps or matching SKUs.
    if (detail.triggerEventId) link({ type: 'RESPONDS_TO',
      from: { type: 'sales_order_event', id: row.id },
      to: { type: 'domain_event', id: detail.triggerEventId } });
    if (['FULFILLED','PARTIALLY_FULFILLED'].includes(row.event_type)) {
      link({ type: 'FULFILLED_BY', from: { type: 'sales_order', id: row.sales_order_id }, to: { type: 'sales_order_event', id: row.id } });
      for (const item of detail.fulfilled || []) {
        for (const id of item.movementIds || []) link({ type: 'CAUSED_MOVEMENT', from: { type: 'sales_order_event', id: row.id }, to: { type: 'inventory_movement', id } });
      }
    }
  });
  // Shipment-to-movement links are provable for shipments created by the
  // shipment service because its fulfillment event carries the shipment ID
  // in an exact idempotency key and the resulting movement IDs in its detail.
  each(db, `SELECT sh.id, sh.sales_order_id, soe.detail
    FROM sales_shipments sh
    LEFT JOIN sales_order_events soe ON soe.workspace_id = sh.workspace_id
      AND soe.idempotency_key = ('sales-shipment:' || sh.id)
    WHERE sh.workspace_id = ? AND sh.status IN ('SHIPPED','DELIVERED')`, [workspaceId], (row) => {
    link({ type: 'FULFILLED_BY', from: { type: 'sales_order', id: row.sales_order_id }, to: { type: 'shipment', id: row.id } });
    for (const item of json(row.detail, {}).fulfilled || []) {
      for (const id of item.movementIds || []) {
        link({ type: 'CAUSED_MOVEMENT', from: { type: 'shipment', id: row.id }, to: { type: 'inventory_movement', id } });
      }
    }
  });
  each(db, `SELECT id, source_email_message_id FROM sales_orders
    WHERE workspace_id = ? AND source_email_message_id IS NOT NULL`, [workspaceId], (row) =>
    link({ type: 'CREATED_FROM', from: { type: 'sales_order', id: row.id }, to: { type: 'email_message', id: row.source_email_message_id } }));

  each(db, `SELECT id, message_id, purchase_order_id FROM supplier_documents
    WHERE workspace_id = ?`, [workspaceId], (row) => {
    if (row.purchase_order_id) link({ type: 'EVIDENCED_BY', from: { type: 'purchase_order', id: row.purchase_order_id }, to: { type: 'supplier_document', id: row.id } });
  });

  each(db, `SELECT id, purchase_order_id, purchase_receipt_id, evidence_message_id,
      evidence_document_id, journal_entry_id FROM accounting_supplier_bills WHERE workspace_id = ?`, [workspaceId], (row) => {
    if (row.purchase_order_id) link({ type: 'BILLED_BY', from: { type: 'purchase_order', id: row.purchase_order_id }, to: { type: 'supplier_bill', id: row.id } });
    if (row.purchase_receipt_id) link({ type: 'BILLED_BY', from: { type: 'purchase_receipt', id: row.purchase_receipt_id }, to: { type: 'supplier_bill', id: row.id } });
    if (row.evidence_message_id) link({ type: 'EVIDENCED_BY', from: { type: 'supplier_bill', id: row.id }, to: { type: 'email_message', id: row.evidence_message_id } });
    if (row.evidence_document_id) link({ type: 'EVIDENCED_BY', from: { type: 'supplier_bill', id: row.id }, to: { type: 'supplier_document', id: row.evidence_document_id } });
    if (row.journal_entry_id) link({ type: 'POSTED_AS', from: { type: 'supplier_bill', id: row.id }, to: { type: 'journal_entry', id: row.journal_entry_id } });
  });
  each(db, 'SELECT id, bill_id FROM accounting_supplier_bill_lines WHERE workspace_id = ?', [workspaceId], (row) =>
    link({ type: 'HAS_PART', from: { type: 'supplier_bill', id: row.bill_id }, to: { type: 'supplier_bill_line', id: row.id } }));
  each(db, `SELECT id, sales_order_id, journal_entry_id FROM accounting_customer_invoices
    WHERE workspace_id = ?`, [workspaceId], (row) => {
    if (row.sales_order_id) link({ type: 'BILLED_BY', from: { type: 'sales_order', id: row.sales_order_id }, to: { type: 'customer_invoice', id: row.id } });
    if (row.journal_entry_id) link({ type: 'POSTED_AS', from: { type: 'customer_invoice', id: row.id }, to: { type: 'journal_entry', id: row.journal_entry_id } });
  });
  each(db, 'SELECT id, invoice_id FROM accounting_customer_invoice_lines WHERE workspace_id = ?', [workspaceId], (row) =>
    link({ type: 'HAS_PART', from: { type: 'customer_invoice', id: row.invoice_id }, to: { type: 'customer_invoice_line', id: row.id } }));

  each(db, `SELECT a.payment_id, a.customer_invoice_id, a.supplier_bill_id
    FROM accounting_payment_allocations a WHERE a.workspace_id = ?`, [workspaceId], (row) => {
    if (row.customer_invoice_id) {
      link({ type: 'PAID_BY', from: { type: 'customer_invoice', id: row.customer_invoice_id }, to: { type: 'payment', id: row.payment_id } });
      const invoice = db.prepare(`SELECT sales_order_id FROM accounting_customer_invoices
        WHERE id = ? AND workspace_id = ?`).get(row.customer_invoice_id, workspaceId);
      if (invoice?.sales_order_id) link({ type: 'PAID_BY', from: { type: 'sales_order', id: invoice.sales_order_id }, to: { type: 'payment', id: row.payment_id } });
    }
    if (row.supplier_bill_id) link({ type: 'PAID_BY', from: { type: 'supplier_bill', id: row.supplier_bill_id }, to: { type: 'payment', id: row.payment_id } });
  });
  each(db, `SELECT id, sales_order_id, journal_entry_id FROM accounting_payments
    WHERE workspace_id = ?`, [workspaceId], (row) => {
    if (row.sales_order_id) link({ type: 'PAID_BY', from: { type: 'sales_order', id: row.sales_order_id }, to: { type: 'payment', id: row.id } });
    link({ type: 'POSTED_AS', from: { type: 'payment', id: row.id }, to: { type: 'journal_entry', id: row.journal_entry_id } });
  });

  const journalSources = {
    purchase_order_receipt: 'purchase_receipt', sales_order_event: 'sales_order_event',
    supplier_bill: 'supplier_bill', customer_invoice: 'customer_invoice',
    payment: 'payment', inventory_movement: 'inventory_movement', domain_event: 'domain_event',
  };
  each(db, `SELECT id, source_record_type, source_record_id, source_event_id
    FROM accounting_journal_entries WHERE workspace_id = ? AND status = 'POSTED'`, [workspaceId], (row) => {
    const type = journalSources[row.source_record_type];
    if (type && row.source_record_id) link({ type: 'POSTED_AS', from: { type, id: row.source_record_id }, to: { type: 'journal_entry', id: row.id } });
    if (row.source_event_id) link({ type: 'POSTED_AS', from: { type: 'domain_event', id: row.source_event_id }, to: { type: 'journal_entry', id: row.id } });
  });

  each(db, `SELECT id, source_record_type, source_record_id FROM domain_events
    WHERE workspace_id = ? AND source_record_type IS NOT NULL AND source_record_id IS NOT NULL`, [workspaceId], (row) => {
    const type = ({ purchase_order_receipt: 'purchase_receipt', sales_order_event: 'sales_order_event',
      payment: 'payment', supplier_bill: 'supplier_bill', customer_invoice: 'customer_invoice' })[row.source_record_type];
    if (type) link({ type: 'EMITTED_EVENT', from: { type, id: row.source_record_id }, to: { type: 'domain_event', id: row.id }, domainEventId: row.id });
  });

  // A work item and trigger event are an explicit persisted causal link.
  if (tableExists(db, 'work_items')) each(db, `SELECT id, trigger_event_id FROM work_items
    WHERE workspace_id = ? AND trigger_event_id IS NOT NULL`, [workspaceId], (row) =>
    link({ type: 'RESPONDS_TO', from: { type: 'work_item', id: row.id }, to: { type: 'domain_event', id: row.trigger_event_id } }));
  if (tableExists(db, 'work_items')) each(db, `SELECT id, purchase_order_id, proposal_id FROM work_items
    WHERE workspace_id = ?`, [workspaceId], (row) => {
    if (row.purchase_order_id) link({ type: 'DECIDED_BY', from: { type: 'purchase_order', id: row.purchase_order_id }, to: { type: 'work_item', id: row.id } });
    if (row.proposal_id) link({ type: 'DECIDED_BY', from: { type: 'work_item', id: row.id }, to: { type: 'action_proposal', id: row.proposal_id } });
  });
  if (tableExists(db, 'action_proposals')) each(db, `SELECT id, source_attention_id FROM action_proposals
    WHERE workspace_id = ? AND source_attention_id IS NOT NULL`, [workspaceId], (row) =>
    link({ type: 'CREATED_FROM', from: { type: 'action_proposal', id: row.id }, to: { type: 'attention_item', id: row.source_attention_id } }));
  if (tableExists(db, 'action_executions')) each(db, `SELECT id, proposal_id FROM action_executions
    WHERE workspace_id = ? AND proposal_id IS NOT NULL`, [workspaceId], (row) =>
    link({ type: 'EXECUTED_AS', from: { type: 'action_proposal', id: row.proposal_id }, to: { type: 'action_execution', id: row.id } }));
  if (tableExists(db, 'action_verifications')) each(db, `SELECT id, execution_id FROM action_verifications
    WHERE workspace_id = ?`, [workspaceId], (row) =>
    link({ type: 'VERIFIED_BY', from: { type: 'action_execution', id: row.execution_id }, to: { type: 'action_verification', id: row.id } }));

  return { recorded };
}

function backfillAll(db) {
  if (!tableExists(db, 'workspaces')) return { workspaces: 0, recorded: 0 };
  let recorded = 0;
  const rows = db.prepare('SELECT id FROM workspaces').all();
  for (const row of rows) recorded += backfillWorkspace(db, row.id).recorded;
  return { workspaces: rows.length, recorded };
}

module.exports = { backfillWorkspace, backfillAll };
