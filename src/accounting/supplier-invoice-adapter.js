'use strict';

/**
 * Converts already-trusted, deterministically matched Mission 13 invoice
 * evidence into AP. It never reads free-form email itself and never receives
 * stock. The supplier evidence engine supplies exact PO-line matches.
 */

const ledger = require('./ledger');
const payables = require('./payables');
const authService = require('../domain/auth-service');

function captureMatchedInvoice(db, message, document, matched) {
  const configured = ledger.settings(db, message.workspace_id);
  if (!configured.enabled || document.document_type !== 'invoice'
    || document.status !== 'MATCHED' || !document.supplier_id || !document.purchase_order_id) {
    return { status: 'IGNORED' };
  }
  if (!Array.isArray(matched) || !matched.length
    || matched.some(({ line, quantity, unitPrice }) => !line || !Number.isFinite(quantity)
      || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0)) {
    return { status: 'NEEDS_REVIEW', reason: 'Invoice lines need exact PO matches, quantities, and prices.' };
  }
  const actor = db.prepare(`SELECT c.authorized_by_user_id AS actor_id, u.account_id
    FROM workspace_connectors c JOIN users u ON u.id = c.authorized_by_user_id
    WHERE c.workspace_id = ? AND c.id = ?`).get(message.workspace_id, message.connector_id);
  if (!actor) return { status: 'NEEDS_REVIEW', reason: 'The connected mailbox has no authorized accounting actor.' };
  const membership = authService.getMembership(db, message.workspace_id, actor.account_id);
  if (!membership || !['owner', 'accountant'].includes(membership.role)) {
    return { status: 'NEEDS_REVIEW', reason: 'An owner or accountant must authorize supplier invoice accounting.' };
  }
  const ctx = { workspaceId: message.workspace_id, actorId: actor.actor_id, accountId: actor.account_id };
  const facts = JSON.parse(document.facts || '{}');
  const receipt = db.prepare(`SELECT r.id FROM purchase_order_receipts r
    WHERE r.workspace_id = ? AND r.purchase_order_id = ?
    ORDER BY r.created_at DESC LIMIT 1`).get(message.workspace_id, document.purchase_order_id);
  const draft = payables.createDraft(db, ctx, membership, {
    supplierId: document.supplier_id,
    purchaseOrderId: document.purchase_order_id,
    purchaseReceiptId: receipt?.id || null,
    supplierInvoiceNumber: document.document_reference || facts.invoiceNumber || null,
    issueDate: String(message.received_at || '').slice(0, 10),
    evidenceMessageId: message.id, evidenceDocumentId: document.id,
    sourceKey: `supplier-document:${document.id}`,
    notes: 'Created from trusted supplier email evidence. No physical stock was received by this invoice.',
    lines: matched.map(({ proposed, line, quantity, unitPrice }) => ({
      description: proposed.description || line.description || line.sku_code,
      quantity, unitCostMinor: Math.round(Number(unitPrice) * 100),
      itemId: line.item_id, skuId: line.sku_id, purchaseOrderLineId: line.id,
    })),
  });
  const bill = payables.open(db, ctx, membership, draft.bill.id);
  return { status: bill.status, billId: bill.id, matchStatus: bill.match_status, replayed: draft.replayed };
}

module.exports = { captureMatchedInvoice };
