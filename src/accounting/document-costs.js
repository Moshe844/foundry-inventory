'use strict';

/*
 * What a supplier document cost, beyond the goods on it.
 *
 * A proforma for 800 pairs of shoes read: $21,390 of shoes, $5,411 of sea
 * freight, $83 of insurance, and $280 credited back for samples. Foundry read
 * all four correctly, showed all four on the proposal screen, posted the
 * $21,390 — and dropped the other $5,214 on the floor, because the only place
 * it knew how to keep a charge was on a purchase order, and an owner saying
 * "this is stock I already have" creates no purchase order.
 *
 * So the money on the document did not add up to the money in the books, and
 * the Money page showed an empty Expenses section beside an inventory value
 * that was five thousand dollars short of what the owner had actually paid.
 *
 * Two rules.
 *
 * Nothing is spread across the products. Freight divided by 800 is a unit
 * cost nobody agreed to, and it makes the document impossible to reconcile
 * against ever again. The charges are kept exactly as the document stated
 * them, in its own words.
 *
 * Nothing is posted until somebody says what it is. Freight on inbound goods
 * can honestly be part of what the stock cost or an expense of its own; that
 * is the owner's decision and their accountant's, not a default. Until they
 * make it the charge is recorded, visible, and explicitly outside the books —
 * which is a truthful state, unlike silence.
 */

const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');

/*
 * Where each kind of charge lands if the owner says it is an expense rather
 * than part of what the stock cost. A kind with no obvious home goes to
 * general operating expense rather than to a guess that reads like precision.
 */
const EXPENSE_ACCOUNT = {
  freight: 'SHIPPING_EXPENSE',
  insurance: 'INSURANCE_EXPENSE',
  duty: 'TAX_EXPENSE',
  tax: 'TAX_EXPENSE',
  discount: 'OPERATING_EXPENSE',
  other: 'OPERATING_EXPENSE',
};

/*
 * A deposit already paid is not a cost at all — it is money moved, and it is
 * settled against the supplier's bill rather than expensed. It is recorded
 * and shown, and deliberately left out of both treatments.
 */
const NOT_A_COST = new Set(['deposit']);

const money = (minor, currency = 'USD') => `${currency} ${(Number(minor || 0) / 100).toFixed(2)}`;

/**
 * Keep what a document said it charged.
 *
 * Idempotent per document and charge, so re-applying, replaying or
 * backfilling the same document never doubles the freight.
 */
function record(db, ctx, input = {}) {
  /*
   * A supplier's paperwork arrives as a PDF or as a spreadsheet, and the money
   * on it is the same money either way.
   */
  const sourceKind = input.importPlanId ? 'import_plan' : 'setup_document';
  const documentId = trimOrNull(input.importPlanId || input.setupDocumentId);
  if (!documentId) throw new ValidationError('A charge has to belong to a document.');
  const charges = Array.isArray(input.charges) ? input.charges : [];
  const now = nowIso();
  const kept = [];
  for (const charge of charges) {
    const label = trimOrNull(charge.label);
    const amountMinor = Math.round(Number(charge.amountMinor || 0));
    if (!label || !Number.isFinite(amountMinor) || amountMinor === 0) continue;
    const known = Boolean(EXPENSE_ACCOUNT[charge.kind]) || NOT_A_COST.has(charge.kind);
    const kind = known ? charge.kind : 'other';
    const existing = db.prepare(`SELECT id FROM document_charges
      WHERE workspace_id = ? AND source_kind = ? AND source_id = ? AND label = ? AND amount_minor = ?`)
      .get(ctx.workspaceId, sourceKind, documentId, label, amountMinor);
    if (existing) { kept.push(existing.id); continue; }
    const id = newId('dchg');
    db.prepare(`INSERT INTO document_charges
        (id, workspace_id, source_kind, source_id, purchase_order_id, document_number, supplier_name,
         label, kind, amount_minor, currency, goods_minor, document_total_minor, opened_books,
         status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNRECORDED', ?)`)
      .run(id, ctx.workspaceId, sourceKind, documentId, trimOrNull(input.purchaseOrderId),
        trimOrNull(input.documentNumber), trimOrNull(input.supplierName),
        label, kind, amountMinor, trimOrNull(input.currency) || 'USD',
        Number(input.goodsMinor || 0), input.documentTotalMinor ?? null,
        input.openedBooks ? 1 : 0, now);
    kept.push(id);
  }
  return kept;
}

/**
 * Every document that charged for something, with its arithmetic.
 *
 * Grouped the way the document itself reads — goods, then each charge, then
 * the total it stated — so the page can be checked against the paper without
 * anybody rearranging anything in their head.
 */
function forWorkspace(db, workspaceId) {
  const rows = db.prepare(`SELECT dc.*, COALESCE(sd.source_name, ip.source_name) AS source_name
    FROM document_charges dc
    LEFT JOIN setup_documents sd ON sd.id = dc.source_id AND dc.source_kind = 'setup_document'
    LEFT JOIN import_plans ip ON ip.id = dc.source_id AND dc.source_kind = 'import_plan'
    WHERE dc.workspace_id = ?
    ORDER BY dc.created_at, dc.rowid`).all(workspaceId);

  const documents = new Map();
  for (const row of rows) {
    if (!documents.has(row.source_id)) {
      documents.set(row.source_id, {
        documentId: row.source_id,
        sourceKind: row.source_kind,
        sourceName: row.source_name,
        documentNumber: row.document_number,
        supplierName: row.supplier_name,
        currency: row.currency,
        goodsMinor: Number(row.goods_minor || 0),
        documentTotalMinor: row.document_total_minor === null ? null : Number(row.document_total_minor),
        openedBooks: Boolean(row.opened_books),
        charges: [],
      });
    }
    const doc = documents.get(row.source_id);
    doc.charges.push({
      id: row.id, label: row.label, kind: row.kind,
      amountMinor: Number(row.amount_minor), status: row.status,
      journalEntryId: row.journal_entry_id,
    });
  }

  return [...documents.values()].map((doc) => {
    const counted = doc.charges.filter((charge) => !NOT_A_COST.has(charge.kind));
    const chargesMinor = counted.reduce((sum, charge) => sum + charge.amountMinor, 0);
    const unrecordedMinor = counted
      .filter((charge) => charge.status === 'UNRECORDED')
      .reduce((sum, charge) => sum + charge.amountMinor, 0);
    const stated = doc.documentTotalMinor;
    const adds = doc.goodsMinor + chargesMinor;
    return {
      ...doc,
      chargesMinor,
      unrecordedMinor,
      /*
       * The document's own total against the sum of its parts. A difference
       * is not corrected here: it is shown, because it means Foundry read
       * something wrong and the owner is the one who can see which line.
       */
      addsUpMinor: adds,
      differsFromStatedMinor: stated === null ? null : stated - adds,
      decided: counted.every((charge) => charge.status !== 'UNRECORDED'),
    };
  });
}

/** What is on documents and not yet in the books, across the workspace. */
function unrecordedTotal(db, workspaceId) {
  const row = db.prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS amount_minor, COUNT(*) AS n
    FROM document_charges WHERE workspace_id = ? AND status = 'UNRECORDED' AND kind <> 'deposit'`)
    .get(workspaceId);
  return { amountMinor: Number(row.amount_minor), count: Number(row.n) };
}

/**
 * Record what the owner decided these costs are.
 *
 * Only offered for a document that opened the books, because that is the one
 * case where the other side of the entry is not in doubt: the goods on it
 * were posted against opening balance equity, so their freight belongs there
 * too. A charge on a document that created a purchase order is already
 * carried on that order, and inventing a second posting for it would be
 * counting the same freight twice.
 */
function settle(db, ctx, membership, input = {}) {
  const ledger = require('./ledger');
  const documentId = trimOrNull(input.documentId);
  const treatment = trimOrNull(input.treatment);
  if (!['stock_value', 'expense'].includes(treatment)) {
    throw new ValidationError('Say whether these costs are part of what the stock cost, or an expense.');
  }
  const document = forWorkspace(db, ctx.workspaceId).find((doc) => doc.documentId === documentId);
  if (!document) throw new NotFoundError('That document has no costs on it.');
  if (!document.openedBooks) {
    throw new ValidationError('These costs are already carried on the purchase order this document created.');
  }
  const pending = document.charges.filter((charge) => charge.status === 'UNRECORDED' && !NOT_A_COST.has(charge.kind));
  if (!pending.length) throw new ValidationError('These costs have already been recorded.');

  const row = document.sourceKind === 'setup_document'
    ? db.prepare('SELECT interpretation FROM setup_documents WHERE id = ? AND workspace_id = ?')
      .get(documentId, ctx.workspaceId)
    : null;
  let interpretation = {};
  try { interpretation = row ? JSON.parse(row.interpretation || '{}') : {}; } catch { /* dated below */ }
  const opened = ledger.settings(db, ctx.workspaceId).startDate;
  /*
   * A charge cannot be posted before the books were opened, and a supplier's
   * invoice is often older than they are. The opening date is the honest place
   * for it: that is where the stock it belongs to was posted too.
   */
  const stated = String(interpretation.documentDate || '').slice(0, 10);
  const postingDate = stated && stated >= opened ? stated : opened;

  const account = (key) => ledger.accountBySystemKey(db, ctx.workspaceId, key);
  const equity = account('OPENING_BALANCE_EQUITY');
  const lines = [];
  let net = 0;

  for (const charge of pending) {
    net += charge.amountMinor;
    const target = treatment === 'stock_value'
      ? account('INVENTORY_ASSET')
      : account(EXPENSE_ACCOUNT[charge.kind] || 'OPERATING_EXPENSE');
    // A credit on the document — a discount, a sample allowance — reduces the
    // same account it would otherwise have added to, rather than becoming
    // income Foundry invented.
    lines.push(charge.amountMinor >= 0
      ? { accountId: target.id, debitMinor: charge.amountMinor, creditMinor: 0, memo: charge.label }
      : { accountId: target.id, debitMinor: 0, creditMinor: -charge.amountMinor, memo: charge.label });
  }
  if (net === 0) throw new ValidationError('These costs cancel out, so there is nothing to record.');
  lines.push(net >= 0
    ? { accountId: equity.id, debitMinor: 0, creditMinor: net, memo: 'Opening balance equity' }
    : { accountId: equity.id, debitMinor: -net, creditMinor: 0, memo: 'Opening balance equity' });

  const posted = ledger.post(db, ctx, {
    postingDate,
    description: treatment === 'stock_value'
      ? `Costs on ${document.documentNumber || document.sourceName} added to what the opening stock cost`
      : `Costs on ${document.documentNumber || document.sourceName} recorded as expenses`,
    sourceType: 'document_charges',
    sourceRecordType: 'setup_document',
    sourceRecordId: documentId,
    sourceKey: `document-charges:${documentId}:${treatment}`,
    createdByType: 'USER',
    approvedByUserId: ctx.actorId,
    lines,
  });

  const now = nowIso();
  const status = treatment === 'stock_value' ? 'IN_STOCK_VALUE' : 'EXPENSED';
  for (const charge of pending) {
    db.prepare(`UPDATE document_charges SET status = ?, journal_entry_id = ?, decided_at = ?
      WHERE id = ? AND workspace_id = ?`)
      .run(status, posted.entry.id, now, charge.id, ctx.workspaceId);
  }
  return { entry: posted.entry, netMinor: net, treatment, charges: pending.length };
}

/**
 * Charges from documents applied before Foundry kept them.
 *
 * The money was read at the time and written into the document's own record,
 * so this is recovery rather than invention: every figure below came off the
 * paper the owner uploaded. Idempotent, and cheap enough to run whenever the
 * Money page is opened.
 */
function backfill(db, workspaceId) {
  const documents = db.prepare(`SELECT id, result, interpretation FROM setup_documents
    WHERE workspace_id = ? AND status = 'APPLIED'`).all(workspaceId);
  let added = 0;
  for (const document of documents) {
    let result;
    let interpretation;
    try {
      result = JSON.parse(document.result || '{}');
      interpretation = JSON.parse(document.interpretation || '{}');
    } catch { continue; }
    const charges = result.charges || interpretation.charges || [];
    if (!charges.length) continue;
    const already = db.prepare(`SELECT COUNT(*) AS n FROM document_charges
      WHERE workspace_id = ? AND source_id = ?`).get(workspaceId, document.id).n;
    if (already) continue;
    added += record(db, { workspaceId }, {
      setupDocumentId: document.id,
      purchaseOrderId: result.purchaseOrderId || null,
      documentNumber: interpretation.documentNumber || null,
      supplierName: result.supplier || interpretation.supplierName || null,
      currency: interpretation.currency || 'USD',
      charges,
      goodsMinor: goodsValueOf(interpretation) || result.openingValueMinor || 0,
      documentTotalMinor: result.documentTotalMinor ?? interpretation.documentTotalMinor ?? null,
      openedBooks: Boolean(result.openingStock),
    }).length;
  }
  return added;
}

/**
 * The value of the goods a document lists, from its own lines.
 *
 * Deliberately the same arithmetic as document-meaning.js uses for the same
 * figure. Two places computing a document's goods value differently is how the
 * page ends up arguing with itself.
 */
function goodsValueOf(interpretation) {
  const lines = (interpretation && interpretation.lines) || [];
  return lines.reduce((sum, line) =>
    sum + Math.round(Number(line.unitCost || 0) * 100) * Number(line.quantity || 0), 0);
}

module.exports = { EXPENSE_ACCOUNT, NOT_A_COST, money, record, forWorkspace, unrecordedTotal, settle, backfill, goodsValueOf };
