'use strict';

/**
 * A bill arrives. Work out which order it is for, and record only the money.
 *
 * A supplier invoice is a demand for payment. It is not a delivery note, and
 * treating it as one is how a business ends up counting stock that is still on
 * a lorry — or in a factory. So nothing here touches on-hand quantities. The
 * only truths an invoice establishes are that money is owed and, once the
 * owner confirms it, that goods are expected.
 *
 * Two situations, and they need different things from the owner:
 *
 *   There is already an order for it. Match the two, compare what was ordered
 *   against what is being billed, and record the bill. Nothing needs anybody
 *   unless the numbers disagree.
 *
 *   There is no order. Businesses buy things outside StockChief all the time, so
 *   this is not an error and the invoice is not thrown away. But StockChief does
 *   not know whether goods are coming, and it will not invent a purchase to
 *   make its own records tidy. It asks one question and waits.
 */

const { ValidationError } = require('../domain/errors');

const normalise = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The order this invoice is about.
 *
 * The number the supplier quotes back is the only reliable signal, so it is
 * the only one used to claim a match. Guessing from supplier and amount would
 * eventually attach a bill to the wrong order, and a wrong match is worse than
 * no match: it silently marks a different order as billed.
 */
function findOrder(db, workspaceId, interpretation, supplierId) {
  const quoted = normalise(interpretation.referencedOrderNumber);
  if (!quoted) return null;
  const candidates = db.prepare(`SELECT * FROM purchase_orders
    WHERE workspace_id = ? AND status NOT IN ('CANCELLED')
    ${supplierId ? 'AND supplier_id = ?' : ''}`)
    .all(...(supplierId ? [workspaceId, supplierId] : [workspaceId]));
  return candidates.find((order) => normalise(order.po_number) === quoted) || null;
}

/**
 * How the bill compares to the order, line by line.
 *
 * Reported rather than acted on. A supplier billing more than was ordered is a
 * conversation, not something for StockChief to resolve by adjusting one side to
 * match the other.
 */
function compare(db, workspaceId, order, interpretation) {
  const orderLines = db.prepare(`SELECT pol.*, s.code FROM purchase_order_lines pol
    LEFT JOIN skus s ON s.id = pol.sku_id
    WHERE pol.purchase_order_id = ? AND pol.workspace_id = ?`).all(order.id, workspaceId);
  const bySupplierSku = new Map(orderLines.map((line) => [normalise(line.supplier_sku || line.code), line]));

  const differences = [];
  let billedMinor = 0;
  let matchedUnits = 0;

  for (const line of interpretation.lines || []) {
    const ordered = bySupplierSku.get(normalise(line.supplierSku));
    const unitMinor = Math.round(Number(line.unitCost || 0) * 100);
    billedMinor += unitMinor * Number(line.quantity || 0);

    if (!ordered) {
      differences.push(`${line.supplierSku || line.styleName} is on the invoice but not on ${order.po_number}.`);
      continue;
    }
    matchedUnits += Number(line.quantity || 0);
    if (Number(line.quantity) !== Number(ordered.quantity_units)) {
      differences.push(`${line.supplierSku}: ordered ${ordered.quantity_units}, billed ${line.quantity}.`);
    }
    const orderedMinor = Math.round(Number(ordered.unit_cost || 0) * 100);
    if (orderedMinor && unitMinor !== orderedMinor) {
      differences.push(`${line.supplierSku}: ordered at ${(orderedMinor / 100).toFixed(2)}, `
        + `billed at ${(unitMinor / 100).toFixed(2)}.`);
    }
  }

  return { differences, billedMinor, matchedUnits, matches: differences.length === 0 };
}

/**
 * Record the money, and nothing else.
 *
 * `expectGoods` is the owner's answer to "are these coming?" and it is the
 * only thing that creates a purchase where none existed. Without it the bill
 * is still recorded — the money is owed either way — and no incoming stock is
 * invented.
 */
function bill(db, ctx, membership, { interpretation, supplierId, order, sourceName, expectGoods = false }) {
  const payables = require('../accounting/payables');
  const settings = require('../accounting/ledger').settings(db, ctx.workspaceId);
  if (!settings.enabled) {
    return { billed: false, because: 'Accounting is not switched on, so there is nowhere to record what is owed.' };
  }

  /*
   * Each invoice line is pointed at the order line it is billing, so the
   * three-way match can do its job. Without that link the bill is just a
   * number next to an order, and nobody can say whether the supplier billed
   * what they shipped.
   */
  const orderLines = order
    ? db.prepare(`SELECT pol.*, s.code FROM purchase_order_lines pol
        LEFT JOIN skus s ON s.id = pol.sku_id
        WHERE pol.purchase_order_id = ? AND pol.workspace_id = ?`).all(order.id, ctx.workspaceId)
    : [];
  const byCode = new Map(orderLines.map((line) => [normalise(line.supplier_sku || line.code), line]));

  const lines = (interpretation.lines || []).map((line) => {
    const ordered = byCode.get(normalise(line.supplierSku));
    return {
      description: line.description || line.styleName || 'Supplier line',
      quantity: Number(line.quantity || 0),
      unitCostMinor: Math.round(Number(line.unitCost || 0) * 100),
      skuId: ordered ? ordered.sku_id : null,
      purchaseOrderLineId: ordered ? ordered.id : null,
    };
  }).filter((line) => line.quantity > 0);
  /*
   * Charges are billed too. Freight on a supplier invoice is money the
   * supplier is asking for, and leaving it off the bill would mean paying an
   * amount that never matches the paper.
   */
  for (const charge of interpretation.charges || []) {
    if (!charge.amountMinor) continue;
    lines.push({ description: charge.label, quantity: 1, unitCostMinor: charge.amountMinor });
  }
  if (!lines.length) {
    return { billed: false, because: 'The invoice has no billable lines.' };
  }

  const draft = payables.createDraft(db, ctx, membership, {
    supplierId,
    purchaseOrderId: order ? order.id : null,
    billNumber: interpretation.documentNumber || undefined,
    issueDate: interpretation.documentDate || undefined,
    dueDate: interpretation.dueDate || null,
    notes: `From ${sourceName}`,
    lines,
  });
  const opened = payables.open(db, ctx, membership, draft.bill.id);
  return { billed: true, bill: opened, expectGoods };
}

module.exports = { findOrder, compare, bill };
