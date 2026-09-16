'use strict';

/*
 * Translate invoice evidence into a reversible, owner-reviewable landed-cost
 * draft. This is intentionally downstream of invoice parsing: the model may
 * identify a freight line and its stated amount, but this service checks the
 * real bill, matched PO and real receipts before it proposes anything.
 */

const landedCosts = require('../accounting/landed-costs');

const ELIGIBLE = new Set(['freight', 'duty', 'insurance', 'handling', 'other']);
const normalized = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

function sourceLineFor(charge, billLines) {
  const amount = Number(charge.amountMinor);
  const label = normalized(charge.label);
  return billLines.find((line) => Number(line.line_total_minor) === amount
    && normalized(line.description) === label) || null;
}

function propose(db, ctx, membership, input) {
  const order = input.purchaseOrder;
  const bill = input.bill;
  const interpretation = input.interpretation || {};
  if (!order || !bill || !['OPEN', 'PARTIALLY_PAID', 'PAID'].includes(bill.status)) {
    return { proposed: false, reason: 'The invoice is not yet a posted bill matched to a purchase order.' };
  }
  const eligible = (interpretation.charges || []).filter((charge) => ELIGIBLE.has(String(charge.kind || '').toLowerCase())
    && Number.isSafeInteger(Number(charge.amountMinor)) && Number(charge.amountMinor) !== 0);
  if (!eligible.length) return { proposed: false, reason: 'The invoice has no eligible landed-cost charges.' };
  const receipts = db.prepare(`SELECT id FROM purchase_order_receipts
    WHERE workspace_id = ? AND purchase_order_id = ? ORDER BY received_at, rowid`)
    .all(ctx.workspaceId, order.id).map((row) => row.id);
  if (!receipts.length) {
    return { proposed: false, waitingFor: 'receipt', purchaseOrderId: order.id,
      reason: 'The invoice has landed costs, but no goods receipt exists yet. StockChief is waiting for physical-delivery evidence.' };
  }
  const charges = [];
  for (const charge of eligible) {
    const sourceLine = sourceLineFor(charge, bill.lines || []);
    if (!sourceLine) {
      return { proposed: false, waitingFor: 'source_bill_line', purchaseOrderId: order.id,
        reason: `StockChief recorded the invoice but could not trace ${charge.label} to one exact bill line, so it did not propose a cost allocation.` };
    }
    charges.push({ category: String(charge.kind).toLowerCase(), description: charge.label,
      amountMinor: Number(charge.amountMinor), sourceBillLineId: sourceLine.id,
      sourceEvidence: input.sourceDocumentId ? `supplier_document:${input.sourceDocumentId}` : 'supplier invoice' });
  }
  // Quantity is the only allocation basis every confirmed receipt proves.
  // A different business rule may later propose value or weight, but StockChief
  // does not infer a product weight or a preferred allocation policy here.
  const created = landedCosts.createDraft(db, ctx, membership, {
    purchaseOrderId: order.id, receiptIds: receipts, allocationMethod: 'quantity', charges,
    note: `Prepared from supplier invoice ${interpretation.documentNumber || bill.bill_number}.`,
  });
  return { proposed: true, documentId: created.document.id, purchaseOrderId: order.id,
    allocationMethod: 'quantity', reason: 'The invoice charge lines, posted bill, and received quantities all agree. StockChief prepared an exact quantity-based split for approval.' };
}

module.exports = { propose, sourceLineFor };
