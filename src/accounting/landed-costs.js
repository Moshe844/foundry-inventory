'use strict';

/*
 * Landed costs are an evidence-led reclassification, not an extra stock
 * receipt. A supplier bill has already credited Accounts Payable once. On
 * application we debit Inventory Asset and credit the exact expense line that
 * the approved bill originally debited, while updating the canonical moving
 * weighted-cost state by the same allocations.
 */

const { inTransaction } = require('../db');
const { ValidationError, NotFoundError } = require('../domain/errors');
const { newId, nowIso, requireText } = require('../lib/util');
const permissions = require('../actions/permissions');
const costing = require('./costing');
const ledger = require('./ledger');
const graph = require('../provenance/service');

const METHODS = new Set(['quantity', 'value', 'weight', 'manual']);
const CATEGORIES = new Set(['freight', 'duty', 'insurance', 'handling', 'other']);

function document(db, workspaceId, id) {
  const row = db.prepare(`SELECT d.*, po.po_number FROM landed_cost_documents d
    LEFT JOIN purchase_orders po ON po.id = d.purchase_order_id
    WHERE d.id = ? AND d.workspace_id = ?`).get(id, workspaceId);
  if (!row) throw new NotFoundError('That landed-cost document could not be found.');
  const receipts = db.prepare(`SELECT r.id, r.purchase_order_id, r.received_at, r.reference
    FROM landed_cost_document_receipts dr JOIN purchase_order_receipts r ON r.id = dr.receipt_id
    WHERE dr.document_id = ? ORDER BY r.received_at, r.rowid`).all(id);
  const charges = db.prepare(`SELECT c.*, bl.bill_id, bl.line_total_minor AS source_line_total_minor,
      bl.debit_account_id, a.system_key AS source_account_key, b.status AS source_bill_status,
      b.journal_entry_id AS source_bill_journal_entry_id
    FROM landed_cost_charges c JOIN accounting_supplier_bill_lines bl ON bl.id = c.source_bill_line_id
    JOIN accounting_supplier_bills b ON b.id = bl.bill_id JOIN accounting_accounts a ON a.id = bl.debit_account_id
    WHERE c.document_id = ? ORDER BY c.rowid`).all(id);
  const allocations = db.prepare(`SELECT a.*, r.quantity_units, s.code AS sku_code, i.name AS item_name,
      l.name AS location_name FROM landed_cost_allocations a
    JOIN purchase_order_receipt_lines r ON r.id = a.receipt_line_id
    JOIN skus s ON s.id = a.sku_id JOIN items i ON i.id = s.item_id JOIN locations l ON l.id = a.location_id
    WHERE a.document_id = ? ORDER BY a.charge_id, a.rowid`).all(id);
  return { ...row, receipts, charges, allocations };
}

function nextNumber(db, workspaceId) {
  let highest = 1000;
  for (const row of db.prepare('SELECT document_number FROM landed_cost_documents WHERE workspace_id = ?').all(workspaceId)) {
    const match = String(row.document_number || '').match(/^LC-(\d+)$/i);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `LC-${highest + 1}`;
}

function listForPurchaseOrder(db, workspaceId, purchaseOrderId) {
  return db.prepare(`SELECT id FROM landed_cost_documents WHERE workspace_id = ? AND purchase_order_id = ?
    ORDER BY created_at DESC`).all(workspaceId, purchaseOrderId).map((row) => document(db, workspaceId, row.id));
}

function checkedReceiptLines(db, workspaceId, receiptIds, purchaseOrderId = null) {
  const ids = [...new Set((receiptIds || []).filter(Boolean))];
  if (!ids.length) throw new ValidationError('Choose at least one received delivery to allocate these costs to.');
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT rl.id AS receipt_line_id, rl.receipt_id, rl.sku_id, rl.location_id,
      rl.quantity_units, pol.unit_cost, r.purchase_order_id, s.code AS sku_code, i.name AS item_name,
      p.unit_weight_grams
    FROM purchase_order_receipt_lines rl JOIN purchase_order_receipts r ON r.id = rl.receipt_id
    JOIN purchase_order_lines pol ON pol.id = rl.purchase_order_line_id
    JOIN skus s ON s.id = rl.sku_id JOIN items i ON i.id = s.item_id
    LEFT JOIN sku_uom_profiles p ON p.sku_id = rl.sku_id
    WHERE rl.workspace_id = ? AND rl.receipt_id IN (${placeholders})
    ORDER BY r.received_at, rl.rowid`).all(workspaceId, ...ids);
  if (rows.length === 0) throw new ValidationError('No received inventory was found for those deliveries.');
  if (purchaseOrderId && rows.some((row) => row.purchase_order_id !== purchaseOrderId)) {
    throw new ValidationError('Every selected receipt must belong to the same purchase order as this landed-cost document.');
  }
  return rows.map((row) => ({ ...row, quantity_units: Number(row.quantity_units), unit_cost: Number(row.unit_cost || 0) }));
}

function validateChargeEvidence(db, workspaceId, charges) {
  if (!Array.isArray(charges) || !charges.length) throw new ValidationError('Add at least one freight, duty, insurance, handling, or other charge.');
  const seen = new Map();
  return charges.map((raw, index) => {
    const amountMinor = Number(raw.amountMinor);
    if (!Number.isSafeInteger(amountMinor) || amountMinor === 0) throw new ValidationError(`Charge ${index + 1} must be a non-zero whole currency amount.`);
    const category = String(raw.category || '').toLowerCase();
    if (!CATEGORIES.has(category)) throw new ValidationError(`Charge ${index + 1} needs a supported category.`);
    const sourceBillLineId = String(raw.sourceBillLineId || '');
    const evidence = db.prepare(`SELECT bl.*, b.workspace_id AS bill_workspace_id, b.status AS bill_status,
        b.journal_entry_id, a.system_key, a.name AS debit_account_name
      FROM accounting_supplier_bill_lines bl JOIN accounting_supplier_bills b ON b.id = bl.bill_id
      JOIN accounting_accounts a ON a.id = bl.debit_account_id WHERE bl.id = ?`).get(sourceBillLineId);
    if (!evidence || evidence.bill_workspace_id !== workspaceId) throw new ValidationError(`Charge ${index + 1} needs a supplier-bill line from this business as evidence.`);
    if (!['OPEN', 'PARTIALLY_PAID', 'PAID'].includes(evidence.bill_status) || !evidence.journal_entry_id) {
      throw new ValidationError(`Open the source supplier bill before capitalising charge ${index + 1}; StockChief will not create a second payable.`);
    }
    if (evidence.system_key === 'INVENTORY_ASSET') {
      throw new ValidationError(`Charge ${index + 1} is already posted to Inventory Asset. It cannot be capitalised a second time.`);
    }
    const existingClaim = Number(db.prepare(`SELECT COALESCE(SUM(ABS(c.amount_minor)), 0) AS n
      FROM landed_cost_charges c JOIN landed_cost_documents d ON d.id = c.document_id
      WHERE c.workspace_id = ? AND c.source_bill_line_id = ?
        AND d.status NOT IN ('VOID','REVERSED')`).get(workspaceId, evidence.id).n);
    const claimed = existingClaim + (seen.get(evidence.id) || 0) + Math.abs(amountMinor);
    if (claimed > Math.abs(Number(evidence.line_total_minor))) {
      throw new ValidationError(`The charges assigned to ${evidence.debit_account_name} exceed its evidenced supplier-bill line.`);
    }
    seen.set(evidence.id, claimed);
    return { category, description: requireText(raw.description || category, `Charge ${index + 1} description`, { max: 250 }),
      amountMinor, sourceBillLineId, sourceEvidence: raw.sourceEvidence || null, evidence };
  });
}

function createDraft(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_ACCOUNTING, 'prepare landed-cost allocations');
  const method = String(input.allocationMethod || '').toLowerCase();
  if (!METHODS.has(method)) throw new ValidationError('Choose quantity, value, weight, or an approved manual allocation method.');
  const receiptLines = checkedReceiptLines(db, ctx.workspaceId, input.receiptIds, input.purchaseOrderId || null);
  const charges = validateChargeEvidence(db, ctx.workspaceId, input.charges);
  const now = nowIso(); const id = newId('lcdoc');
  return inTransaction(db, () => {
    db.prepare(`INSERT INTO landed_cost_documents
      (id, workspace_id, document_number, purchase_order_id, allocation_method, status, currency, note,
       created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`)
      .run(id, ctx.workspaceId, input.documentNumber || nextNumber(db, ctx.workspaceId), input.purchaseOrderId || null,
        method, ledger.settings(db, ctx.workspaceId).currency, input.note || null, ctx.actorId, now, now);
    const receiptInsert = db.prepare('INSERT INTO landed_cost_document_receipts (document_id, receipt_id) VALUES (?, ?)');
    for (const receiptId of [...new Set(receiptLines.map((line) => line.receipt_id))]) receiptInsert.run(id, receiptId);
    const chargeInsert = db.prepare(`INSERT INTO landed_cost_charges
      (id, workspace_id, document_id, category, description, amount_minor, source_bill_line_id, source_evidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const charge of charges) chargeInsert.run(newId('lccharge'), ctx.workspaceId, id, charge.category,
      charge.description, charge.amountMinor, charge.sourceBillLineId, charge.sourceEvidence, now);
    graph.recordMany(db, ctx.workspaceId, [
      ...receiptLines.map((line) => ({ type: 'CAPITALIZES_COST_OF', from: { type: 'landed_cost_document', id },
        to: { type: 'purchase_receipt', id: line.receipt_id }, basis: 'DIRECT_RECORD' })),
      ...charges.map((charge) => ({ type: 'EVIDENCED_BY', from: { type: 'landed_cost_document', id },
        to: { type: 'supplier_bill_line', id: charge.sourceBillLineId }, basis: 'DIRECT_RECORD' })),
    ], { basis: 'DIRECT_RECORD' });
    return { document: document(db, ctx.workspaceId, id), preview: preview(db, ctx.workspaceId, id, input.manualAllocations) };
  });
}

function basisFor(lines, method) {
  if (method === 'quantity') return lines.map((line) => ({ ...line, basisValue: line.quantity_units }));
  if (method === 'value') {
    const missing = lines.filter((line) => !Number.isFinite(line.unit_cost) || line.unit_cost <= 0);
    if (missing.length) throw new ValidationError(`StockChief needs the product cost for ${missing[0].item_name} (${missing[0].sku_code}) before it can allocate by value. No cost was guessed.`);
    return lines.map((line) => ({ ...line, basisValue: Math.round(line.quantity_units * line.unit_cost * 100) }));
  }
  if (method === 'weight') {
    const missing = lines.filter((line) => !Number.isSafeInteger(Number(line.unit_weight_grams)) || Number(line.unit_weight_grams) <= 0);
    if (missing.length) throw new ValidationError(`StockChief needs the unit weight for ${missing[0].item_name} (${missing[0].sku_code}) before it can allocate by weight. No weight was guessed.`);
    return lines.map((line) => ({ ...line, basisValue: line.quantity_units * Number(line.unit_weight_grams) }));
  }
  return lines.map((line) => ({ ...line, basisValue: 0 }));
}

// Largest-remainder allocation is deterministic: every source charge is
// reconciled exactly, and a retry will select the same cents in the same order.
function allocateExact(amountMinor, lines) {
  const sign = Math.sign(amountMinor); const total = Math.abs(amountMinor);
  const basisTotal = lines.reduce((sum, line) => sum + Number(line.basisValue), 0);
  if (basisTotal <= 0) throw new ValidationError('The chosen allocation method has no positive basis to allocate.');
  let assigned = 0;
  const portions = lines.map((line) => {
    const exact = total * Number(line.basisValue) / basisTotal;
    const floor = Math.floor(exact); assigned += floor;
    return { ...line, amountMinor: floor * sign, remainder: exact - floor };
  });
  let remaining = total - assigned;
  portions.sort((a, b) => b.remainder - a.remainder || String(a.receipt_line_id).localeCompare(String(b.receipt_line_id)));
  for (let i = 0; i < remaining; i += 1) portions[i % portions.length].amountMinor += sign;
  return portions.sort((a, b) => String(a.receipt_line_id).localeCompare(String(b.receipt_line_id)));
}

function manualFor(charge, lines, manualAllocations) {
  const submitted = (manualAllocations || []).filter((row) => row.chargeId === charge.id || row.chargeIndex === charge.index);
  if (!submitted.length) throw new ValidationError(`Enter the approved manual allocation for ${charge.description}.`);
  const allowed = new Map(lines.map((line) => [line.receipt_line_id, line]));
  const output = submitted.map((row) => {
    const line = allowed.get(row.receiptLineId);
    const amountMinor = Number(row.amountMinor);
    if (!line || !Number.isSafeInteger(amountMinor) || amountMinor === 0) throw new ValidationError('Every manual landed-cost amount must target a received product line and use whole currency units.');
    return { ...line, basisValue: 0, amountMinor };
  });
  if (output.reduce((sum, row) => sum + row.amountMinor, 0) !== Number(charge.amount_minor)) {
    throw new ValidationError(`The manual allocation for ${charge.description} must reconcile exactly to its source charge.`);
  }
  return output;
}

function preview(db, workspaceId, documentId, manualAllocations = []) {
  const doc = document(db, workspaceId, documentId);
  if (doc.status === 'VOID' || doc.status === 'REVERSED') throw new ValidationError('This landed-cost document is no longer available for allocation.');
  const lines = checkedReceiptLines(db, workspaceId, doc.receipts.map((receipt) => receipt.id), doc.purchase_order_id);
  const basis = doc.allocation_method === 'manual' ? lines : basisFor(lines, doc.allocation_method);
  const allocations = [];
  for (const [index, charge] of doc.charges.entries()) {
    const allocated = doc.allocation_method === 'manual'
      ? manualFor({ ...charge, index }, basis, manualAllocations)
      : allocateExact(Number(charge.amount_minor), basis);
    allocations.push(...allocated.map((line) => ({ chargeId: charge.id, receiptLineId: line.receipt_line_id,
      skuId: line.sku_id, locationId: line.location_id, skuCode: line.sku_code, itemName: line.item_name,
      quantityUnits: line.quantity_units, basisValue: Number(line.basisValue), amountMinor: Number(line.amountMinor) })));
  }
  const sourceTotalMinor = doc.charges.reduce((sum, charge) => sum + Number(charge.amount_minor), 0);
  const allocatedTotalMinor = allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
  if (sourceTotalMinor !== allocatedTotalMinor) throw new Error('Landed-cost allocation did not reconcile to its source charges.');
  return { documentId: doc.id, method: doc.allocation_method, sourceTotalMinor, allocatedTotalMinor, allocations,
    needsExplicitApproval: true };
}

function approve(db, ctx, membership, documentId, manualAllocations = []) {
  permissions.assertCan(membership, permissions.ALLOCATE_LANDED_COST, 'approve landed-cost allocations');
  const doc = document(db, ctx.workspaceId, documentId);
  if (doc.status === 'APPLIED') return { document: doc, replayed: true };
  if (doc.status !== 'DRAFT') throw new ValidationError('Only a draft landed-cost document can be approved.');
  const result = preview(db, ctx.workspaceId, documentId, manualAllocations);
  db.prepare(`UPDATE landed_cost_documents SET status = 'APPROVED', approved_by_user_id = ?, approved_at = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND status = 'DRAFT'`).run(ctx.actorId, nowIso(), nowIso(), documentId, ctx.workspaceId);
  return { document: document(db, ctx.workspaceId, documentId), preview: result, replayed: false };
}

function assertStillOnHand(db, ctx, allocations) {
  for (const allocation of allocations) {
    const balance = costing.state(db, ctx.workspaceId, allocation.skuId, allocation.locationId);
    if (Number(balance.quantity_units) <= 0) {
      throw new ValidationError(`StockChief cannot capitalise ${allocation.itemName} (${allocation.skuCode}) automatically because none of the received stock remains at that location. The historical COGS correction needs accountant approval; no amount was guessed.`);
    }
  }
}

function apply(db, ctx, membership, documentId, manualAllocations = []) {
  permissions.assertCan(membership, permissions.ALLOCATE_LANDED_COST, 'apply landed-cost allocations');
  permissions.assertCan(membership, permissions.MANAGE_ACCOUNTING, 'apply landed-cost allocations');
  return inTransaction(db, () => {
    const doc = document(db, ctx.workspaceId, documentId);
    if (doc.status === 'APPLIED') return { document: doc, replayed: true };
    if (doc.status !== 'APPROVED') throw new ValidationError('Review and approve this landed-cost allocation before applying it.');
    const result = preview(db, ctx.workspaceId, documentId, manualAllocations);
    assertStillOnHand(db, ctx, result.allocations);
    const sourceAccounts = new Map(doc.charges.map((charge) => [charge.id, charge.debit_account_id]));
    const journalLines = [];
    for (const allocation of result.allocations) {
      const sku = db.prepare('SELECT item_id FROM skus WHERE id = ?').get(allocation.skuId);
      const amount = allocation.amountMinor;
      if (amount > 0) journalLines.push({ accountKey: 'INVENTORY_ASSET', debitMinor: amount,
        itemId: sku.item_id, skuId: allocation.skuId, locationId: allocation.locationId,
        memo: `Capitalised landed cost from ${doc.document_number}` });
      else journalLines.push({ accountKey: 'INVENTORY_ASSET', creditMinor: Math.abs(amount),
        itemId: sku.item_id, skuId: allocation.skuId, locationId: allocation.locationId,
        memo: `Landed-cost credit from ${doc.document_number}` });
    }
    for (const charge of doc.charges) {
      const amount = Number(charge.amount_minor);
      journalLines.push(amount > 0
        ? { accountId: sourceAccounts.get(charge.id), creditMinor: amount, memo: `Capitalised by ${doc.document_number}` }
        : { accountId: sourceAccounts.get(charge.id), debitMinor: Math.abs(amount), memo: `Landed-cost credit by ${doc.document_number}` });
    }
    const posted = ledger.post(db, ctx, { postingDate: nowIso().slice(0, 10),
      description: `Landed cost ${doc.document_number}`, sourceType: 'landed_cost_document',
      sourceRecordType: 'landed_cost_document', sourceRecordId: doc.id, sourceKey: `landed-cost:${doc.id}`,
      createdByType: 'SYSTEM', approvedByUserId: doc.approved_by_user_id,
      metadata: { allocationMethod: doc.allocation_method, sourceTotalMinor: result.sourceTotalMinor }, lines: journalLines });
    const insert = db.prepare(`INSERT INTO landed_cost_allocations
      (id, workspace_id, document_id, charge_id, receipt_line_id, sku_id, location_id, basis_value, amount_minor,
       accounting_journal_entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const allocation of result.allocations) {
      insert.run(newId('lcalloc'), ctx.workspaceId, doc.id, allocation.chargeId, allocation.receiptLineId,
        allocation.skuId, allocation.locationId, allocation.basisValue, allocation.amountMinor, posted.entry.id, nowIso());
    }
    const saved = document(db, ctx.workspaceId, documentId);
    for (const allocation of saved.allocations) {
      costing.adjustValue(db, ctx, { sourceType: 'landed_cost_allocation', sourceRecordId: allocation.id,
        journalEntryId: posted.entry.id, adjustments: [{ skuId: allocation.sku_id, locationId: allocation.location_id,
          amountDeltaMinor: Number(allocation.amount_minor) }] });
    }
    db.prepare(`UPDATE landed_cost_documents SET status = 'APPLIED', applied_at = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`).run(nowIso(), nowIso(), doc.id, ctx.workspaceId);
    graph.recordMany(db, ctx.workspaceId, [
      { type: 'POSTED_AS', from: { type: 'landed_cost_document', id: doc.id }, to: { type: 'journal_entry', id: posted.entry.id }, basis: 'EVENT' },
      ...saved.allocations.map((allocation) => ({ type: 'CAPITALIZES_COST_OF', from: { type: 'landed_cost_document', id: doc.id },
        to: { type: 'purchase_receipt_line', id: allocation.receipt_line_id }, basis: 'DIRECT_RECORD' })),
    ], { basis: 'DIRECT_RECORD' });
    return { document: document(db, ctx.workspaceId, doc.id), journalEntry: posted.entry, replayed: false };
  });
}

/**
 * Correct an applied allocation through immutable negatives and a reversing
 * journal.  We never edit the original charge, receipt, bill, or cost row.
 * If stock has since been exhausted at the original location, costing refuses
 * the reversal rather than silently rewriting historical COGS.
 */
function reverse(db, ctx, membership, documentId, input = {}) {
  permissions.assertCan(membership, permissions.ALLOCATE_LANDED_COST, 'reverse landed-cost allocations');
  permissions.assertCan(membership, permissions.MANAGE_ACCOUNTING, 'reverse landed-cost allocations');
  return inTransaction(db, () => {
    const doc = document(db, ctx.workspaceId, documentId);
    if (doc.status === 'REVERSED') return { document: doc, replayed: true };
    if (doc.status !== 'APPLIED') throw new ValidationError('Only an applied landed-cost document can be reversed.');
    const journalId = doc.allocations[0] && doc.allocations[0].accounting_journal_entry_id;
    if (!journalId) throw new ValidationError('This landed-cost document has no immutable accounting posting to reverse.');
    // Check all value changes before posting the reversal, so a rejected
    // historical correction cannot leave a half-completed journal behind.
    for (const allocation of doc.allocations) {
      const balance = costing.state(db, ctx.workspaceId, allocation.sku_id, allocation.location_id);
      if (Number(balance.total_cost_minor) < Number(allocation.amount_minor)) {
        throw new ValidationError('This landed-cost correction reaches stock that has already been sold or revalued. An accountant must make the historical COGS correction; StockChief left the original evidence unchanged.');
      }
    }
    const reversed = ledger.reverse(db, ctx, membership, journalId, {
      reason: input.reason || 'Landed-cost allocation correction', postingDate: input.postingDate || nowIso().slice(0, 10),
    });
    for (const allocation of doc.allocations) {
      costing.adjustValue(db, ctx, { sourceType: 'landed_cost_allocation_reversal',
        sourceRecordId: `${doc.id}:${allocation.id}`, journalEntryId: reversed.entry.id,
        adjustments: [{ skuId: allocation.sku_id, locationId: allocation.location_id,
          amountDeltaMinor: -Number(allocation.amount_minor) }] });
    }
    db.prepare(`UPDATE landed_cost_documents SET status = 'REVERSED', reversed_at = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`).run(nowIso(), nowIso(), doc.id, ctx.workspaceId);
    return { document: document(db, ctx.workspaceId, doc.id), journalEntry: reversed.entry, replayed: false };
  });
}

module.exports = { nextNumber, document, listForPurchaseOrder, createDraft, preview, approve, apply, reverse, allocateExact };
