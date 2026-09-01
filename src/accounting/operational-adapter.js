'use strict';

/**
 * Translates durable operational events into deterministic accounting.
 *
 * This module never mutates physical inventory, purchasing, or sales records.
 * It records one accounting-inbox row per domain event and either posts a
 * fully evidenced consequence, ignores a non-financial event, or preserves a
 * reviewable exception. Failures never roll back the business event.
 */

const { inTransaction } = require('../db');
const { newId, nowIso } = require('../lib/util');
const ledger = require('./ledger');
const costing = require('./costing');
const openingCostEvidence = require('./opening-cost-evidence');

const AUTOMATIC = new Set([
  'purchase_order.partially_received',
  'purchase_order.completed',
  'sales_order.partially_fulfilled',
  'sales_order.fulfilled',
  'inventory.transferred',
  'inventory.issued',
  'inventory.received',
  'inventory.corrected',
  'connector.sale.completed',
  'connector.return.completed',
]);

function parse(value, fallback) {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}

function inbox(db, workspaceId, eventId) {
  const row = db.prepare(`SELECT * FROM accounting_event_inbox
    WHERE workspace_id = ? AND domain_event_id = ?`).get(workspaceId, eventId);
  return row ? { ...row, outcome: parse(row.outcome, {}) } : null;
}

function eventBusinessDate(db, event) {
  if (event.payload && event.payload.occurredAt) {
    const date = String(event.payload.occurredAt).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  }
  if (event.sourceRecordType === 'movement' && event.sourceRecordId) {
    const movement = db.prepare('SELECT occurred_at FROM movements WHERE id = ? AND workspace_id = ?')
      .get(event.sourceRecordId, event.workspaceId);
    if (movement) return movement.occurred_at.slice(0, 10);
  }
  if (event.payload && event.payload.receiptId) {
    const receipt = db.prepare(`SELECT created_at FROM purchase_order_receipts
      WHERE id = ? AND workspace_id = ?`).get(event.payload.receiptId, event.workspaceId);
    if (receipt) return receipt.created_at.slice(0, 10);
  }
  if (event.sourceRecordType === 'sales_order_event' && event.sourceRecordId) {
    const sale = db.prepare(`SELECT created_at FROM sales_order_events
      WHERE id = ? AND workspace_id = ?`).get(event.sourceRecordId, event.workspaceId);
    if (sale) return sale.created_at.slice(0, 10);
  }
  return String(event.createdAt || nowIso()).slice(0, 10);
}

function setOutcome(db, rowId, status, outcome, error = null, journalEntryId = null) {
  db.prepare(`UPDATE accounting_event_inbox SET status = ?, outcome = ?, error_message = ?,
    journal_entry_id = ?, processed_at = ? WHERE id = ?`)
    .run(status, JSON.stringify(outcome || {}), error ? String(error.message || error) : null,
      journalEntryId || null, nowIso(), rowId);
}

function receiptDetails(db, workspaceId, receiptId) {
  const receipt = db.prepare(`SELECT r.*, po.po_number, po.supplier_id, po.currency
    FROM purchase_order_receipts r JOIN purchase_orders po ON po.id = r.purchase_order_id
    WHERE r.id = ? AND r.workspace_id = ?`).get(receiptId, workspaceId);
  if (!receipt) throw new Error('The purchase receipt referenced by this event no longer exists.');
  const lines = db.prepare(`SELECT rl.*, pol.unit_cost, pol.quantity_received_units, sk.item_id
    FROM purchase_order_receipt_lines rl
    JOIN purchase_order_lines pol ON pol.id = rl.purchase_order_line_id
    JOIN skus sk ON sk.id = rl.sku_id
    WHERE rl.receipt_id = ? AND rl.workspace_id = ? ORDER BY rl.rowid`).all(receiptId, workspaceId)
    .map((line) => ({ ...line, movementIds: parse(line.movement_ids, []) }));
  if (!lines.length) throw new Error('The purchase receipt has no lines to account for.');
  if (lines.some((line) => line.unit_cost === null || line.unit_cost === undefined)) {
    throw new Error('The purchase receipt is missing an approved unit cost.');
  }
  return { receipt, lines };
}

function postPurchaseReceipt(db, event, postingDate) {
  const { receipt, lines } = receiptDetails(db, event.workspaceId, event.payload.receiptId);
  return inTransaction(db, () => {
    const inventoryLines = lines.map((line) => {
      const unitCostMinor = Math.round(Number(line.unit_cost) * 100);
      const amount = unitCostMinor * Number(line.quantity_units);
      if (!Number.isSafeInteger(unitCostMinor) || unitCostMinor < 0 || !Number.isSafeInteger(amount)) {
        throw new Error('The approved purchase cost cannot be represented safely in minor currency units.');
      }
      const billedUnits = Number(db.prepare(`SELECT COALESCE(SUM(bl.quantity), 0) AS n
        FROM accounting_supplier_bill_lines bl
        JOIN accounting_supplier_bills b ON b.id = bl.bill_id
        WHERE bl.workspace_id = ? AND bl.purchase_order_line_id = ?
          AND b.status IN ('OPEN','PARTIALLY_PAID','PAID')`)
        .get(event.workspaceId, line.purchase_order_line_id).n);
      const receivedBefore = Math.max(0,
        Number(line.quantity_received_units) - Number(line.quantity_units));
      const billedWaitingForReceipt = Math.max(0, billedUnits - receivedBefore);
      const inTransitUnits = Math.min(Number(line.quantity_units), billedWaitingForReceipt);
      const inTransitAmount = inTransitUnits * unitCostMinor;
      return { line, unitCostMinor, amount, inTransitUnits, inTransitAmount,
        uninvoicedAmount: amount - inTransitAmount };
    });
    const total = inventoryLines.reduce((sum, line) => sum + line.amount, 0);
    if (total <= 0) throw new Error('A zero-value receipt needs an explicit accounting decision.');
    const posted = ledger.post(db, { workspaceId: event.workspaceId, actorId: receipt.received_by_user_id }, {
      postingDate,
      description: `Received ${receipt.po_number}`,
      sourceType: 'purchase_receipt', sourceRecordType: 'purchase_order_receipt',
      sourceRecordId: receipt.id, sourceEventId: event.id,
      sourceKey: `purchase-receipt:${receipt.id}`,
      createdByType: 'SYSTEM',
      metadata: { purchaseOrderId: receipt.purchase_order_id, poNumber: receipt.po_number,
        receiptId: receipt.id, supplierId: receipt.supplier_id },
      lines: [
        ...inventoryLines.map(({ line, amount }) => ({
          accountKey: 'INVENTORY_ASSET', debitMinor: amount,
          supplierId: receipt.supplier_id, itemId: line.item_id,
          skuId: line.sku_id, locationId: line.location_id,
          memo: `${line.quantity_units} received`,
        })),
        ...inventoryLines.filter(({ inTransitAmount }) => inTransitAmount > 0)
          .map(({ line, inTransitAmount, inTransitUnits }) => ({
            accountKey: 'INVENTORY_IN_TRANSIT', creditMinor: inTransitAmount,
            supplierId: receipt.supplier_id, itemId: line.item_id, skuId: line.sku_id,
            memo: `${inTransitUnits} previously invoiced unit${inTransitUnits === 1 ? '' : 's'} arrived`,
          })),
        ...inventoryLines.filter(({ uninvoicedAmount }) => uninvoicedAmount > 0)
          .map(({ line, uninvoicedAmount }) => ({
            accountKey: 'RECEIVED_NOT_INVOICED', creditMinor: uninvoicedAmount,
            supplierId: receipt.supplier_id, itemId: line.item_id, skuId: line.sku_id,
            memo: `${receipt.po_number} received before supplier invoice`,
          })),
      ],
    });
    for (const { line, unitCostMinor } of inventoryLines) {
      costing.receive(db, { workspaceId: event.workspaceId }, {
        movementIds: line.movementIds, unitCostMinor,
        journalEntryId: posted.entry.id,
        sourceType: 'purchase_receipt', sourceRecordId: receipt.id,
      });
    }
    return { journalEntryId: posted.entry.id, replayed: posted.replayed,
      kind: 'purchase_receipt', poNumber: receipt.po_number, amountMinor: total,
      units: lines.reduce((sum, line) => sum + Number(line.quantity_units), 0) };
  });
}

function saleEventDetails(db, event) {
  const saleEvent = db.prepare(`SELECT * FROM sales_order_events
    WHERE id = ? AND workspace_id = ?`).get(event.sourceRecordId, event.workspaceId);
  if (!saleEvent) throw new Error('The sales fulfillment event could not be found.');
  const detail = parse(saleEvent.detail, {});
  const fulfilled = Array.isArray(detail.fulfilled) ? detail.fulfilled : [];
  if (!fulfilled.length) throw new Error('The sales fulfillment has no physical lines.');
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ? AND workspace_id = ?')
    .get(saleEvent.sales_order_id, event.workspaceId);
  if (!order) throw new Error('The fulfilled sales order could not be found.');
  const byId = new Map(db.prepare(`SELECT sol.*, s.item_id FROM sales_order_lines sol
    JOIN skus s ON s.id = sol.sku_id WHERE sol.sales_order_id = ? AND sol.workspace_id = ?`)
    .all(order.id, event.workspaceId).map((line) => [line.id, line]));
  const lines = fulfilled.map((entry) => {
    const line = byId.get(entry.lineId);
    if (!line) throw new Error('A fulfilled sales line could not be matched to the order.');
    if (line.unit_price_minor === null || line.unit_price_minor === undefined) {
      throw new Error('The fulfilled sales line has no approved selling price.');
    }
    return { ...entry, line, quantity: Number(entry.quantity),
      movementIds: Array.isArray(entry.movementIds) ? entry.movementIds : [] };
  });
  return { saleEvent, detail, order, lines };
}

function postSaleFulfillment(db, event, postingDate) {
  const { saleEvent, order, lines } = saleEventDetails(db, event);
  return inTransaction(db, () => {
    const state = db.prepare(`SELECT * FROM accounting_sales_recognition
      WHERE workspace_id = ? AND sales_order_id = ?`).get(event.workspaceId, order.id) || {
      fulfilled_units: 0, gross_minor: 0, discount_minor: 0, tax_minor: 0, net_receivable_minor: 0,
    };
    const gross = lines.reduce((sum, entry) => sum
      + Number(entry.line.unit_price_minor) * entry.quantity, 0);
    const orderedSubtotal = db.prepare(`SELECT COALESCE(SUM(quantity_ordered * unit_price_minor), 0) AS n
      FROM sales_order_lines WHERE sales_order_id = ? AND workspace_id = ?`)
      .get(order.id, event.workspaceId).n;
    if (!Number.isSafeInteger(gross) || gross < 0 || !Number.isSafeInteger(Number(orderedSubtotal))) {
      throw new Error('The sale price cannot be represented safely in minor currency units.');
    }
    const final = event.type === 'sales_order.fulfilled' || order.status === 'FULFILLED';
    const remainingDiscount = Math.max(0, Number(order.discount_minor || 0) - Number(state.discount_minor));
    const remainingTax = Math.max(0, Number(order.tax_minor || 0) - Number(state.tax_minor));
    const discount = final ? remainingDiscount
      : Math.min(remainingDiscount, Math.round(Number(order.discount_minor || 0) * gross / Math.max(1, Number(orderedSubtotal))));
    const tax = final ? remainingTax
      : Math.min(remainingTax, Math.round(Number(order.tax_minor || 0) * gross / Math.max(1, Number(orderedSubtotal))));
    const revenue = gross - discount;
    if (revenue < 0) throw new Error('Allocated sales discount exceeds the fulfilled revenue.');

    // Cost first inside the shared transaction. If posting fails, the outer
    // transaction rolls the cost allocation back with it.
    const issued = lines.map((entry) => costing.issue(db, { workspaceId: event.workspaceId }, {
      movementIds: entry.movementIds, sourceType: 'sales_fulfillment', sourceRecordId: saleEvent.id,
    }));
    const cogs = issued.reduce((sum, result) => sum + Number(result.totalCostMinor), 0);
    const receivable = revenue + tax;
    const journalLines = [];
    if (receivable > 0) journalLines.push({ accountKey: 'ACCOUNTS_RECEIVABLE', debitMinor: receivable,
      customerId: order.customer_id, memo: order.order_number });
    let allocatedDiscount = 0;
    let cumulativeGross = 0;
    lines.forEach((entry, index) => {
      const lineGross = Number(entry.line.unit_price_minor) * entry.quantity;
      cumulativeGross += lineGross;
      const lineDiscount = index === lines.length - 1 ? discount - allocatedDiscount
        : Math.round(discount * cumulativeGross / Math.max(1, gross)) - allocatedDiscount;
      allocatedDiscount += lineDiscount;
      const lineRevenue = lineGross - lineDiscount;
      if (lineRevenue > 0) journalLines.push({ accountKey: 'SALES_REVENUE', creditMinor: lineRevenue,
        customerId: order.customer_id, itemId: entry.line.item_id, skuId: entry.line.sku_id,
        locationId: entry.locationId || null, memo: order.order_number });
      const lineCogs = Number(issued[index].totalCostMinor || 0);
      if (lineCogs > 0) {
        journalLines.push({ accountKey: 'COST_OF_GOODS_SOLD', debitMinor: lineCogs,
          customerId: order.customer_id, itemId: entry.line.item_id, skuId: entry.line.sku_id,
          locationId: entry.locationId || null, memo: order.order_number });
        journalLines.push({ accountKey: 'INVENTORY_ASSET', creditMinor: lineCogs,
          customerId: order.customer_id, itemId: entry.line.item_id, skuId: entry.line.sku_id,
          locationId: entry.locationId || null, memo: order.order_number });
      }
    });
    if (tax > 0) journalLines.push({ accountKey: 'SALES_TAX_PAYABLE', creditMinor: tax,
      customerId: order.customer_id, memo: order.order_number });
    if (journalLines.length < 2) throw new Error('This fulfillment has no non-zero accounting consequence.');
    const posted = ledger.post(db, { workspaceId: event.workspaceId, actorId: saleEvent.actor_user_id }, {
      postingDate, description: `Fulfilled ${order.order_number}`,
      sourceType: 'sales_fulfillment', sourceRecordType: 'sales_order_event',
      sourceRecordId: saleEvent.id, sourceEventId: event.id,
      sourceKey: `sales-fulfillment:${saleEvent.id}`, createdByType: 'SYSTEM',
      metadata: { salesOrderId: order.id, orderNumber: order.order_number,
        grossMinor: gross, discountMinor: discount, taxMinor: tax,
        revenueMinor: revenue, cogsMinor: cogs },
      lines: journalLines,
    });
    const units = lines.reduce((sum, entry) => sum + entry.quantity, 0);
    // The journal source key is the financial idempotency boundary. A retry can
    // legitimately reach this adapter after the journal was already posted
    // (for example, while repairing an older review). Do not append a second
    // receivable line or increment sales recognition when that happens.
    if (posted.replayed) {
      const metadata = posted.entry.metadata || {};
      return { journalEntryId: posted.entry.id, replayed: true,
        kind: 'sales_fulfillment', orderNumber: order.order_number,
        revenueMinor: Number(metadata.revenueMinor ?? revenue),
        taxMinor: Number(metadata.taxMinor ?? tax),
        cogsMinor: Number(metadata.cogsMinor ?? cogs),
        units: Number(metadata.units ?? units) };
    }
    db.prepare(`INSERT INTO accounting_sales_recognition
      (workspace_id, sales_order_id, fulfilled_units, gross_minor, discount_minor,
       tax_minor, net_receivable_minor, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, sales_order_id) DO UPDATE SET
        fulfilled_units = fulfilled_units + excluded.fulfilled_units,
        gross_minor = gross_minor + excluded.gross_minor,
        discount_minor = discount_minor + excluded.discount_minor,
        tax_minor = tax_minor + excluded.tax_minor,
        net_receivable_minor = net_receivable_minor + excluded.net_receivable_minor,
        updated_at = excluded.updated_at`)
      .run(event.workspaceId, order.id, units, gross, discount, tax, receivable, nowIso());
    recordSalesOrderReceivable(db, event, order, lines, posted.entry.id,
      postingDate, gross, discount, tax, receivable);
    return { journalEntryId: posted.entry.id, replayed: posted.replayed,
      kind: 'sales_fulfillment', orderNumber: order.order_number,
      revenueMinor: revenue, taxMinor: tax, cogsMinor: cogs, units };
  });
}

/**
 * A legacy workspace may have received stock from an exact-cost PO before the
 * automatic accounting adapter existed. Reconstruct the verified weighted
 * average immediately before this fulfillment so the sale can post without a
 * manual amount. The target fulfillment movements are deliberately excluded:
 * costing.issue below must consume them exactly once.
 */
function recoverVerifiedCostBeforeSale(db, event) {
  const configured = ledger.settings(db, event.workspaceId);
  if (!configured.enabled || !configured.startDate) return null;
  const { lines } = saleEventDetails(db, event);
  const movementIds = [...new Set(lines.flatMap((entry) => entry.movementIds || []))];
  if (!movementIds.length) return null;
  const placeholders = movementIds.map(() => '?').join(',');
  const first = db.prepare(`SELECT occurred_at FROM movements
    WHERE workspace_id = ? AND id IN (${placeholders}) ORDER BY occurred_at, seq LIMIT 1`)
    .get(event.workspaceId, ...movementIds);
  if (!first) return null;
  const required = new Map();
  for (const entry of lines) {
    const key = `${entry.line.sku_id}:${entry.locationId}`;
    const row = required.get(key) || { skuId: entry.line.sku_id, locationId: entry.locationId, quantity: 0 };
    row.quantity += Number(entry.quantity);
    required.set(key, row);
  }
  const missing = [...required.values()].filter((target) => Number(costing.state(db, event.workspaceId,
    target.skuId, target.locationId).quantity_units) < target.quantity);
  if (!missing.length) return null;
  const inference = openingCostEvidence.infer(db, event.workspaceId, configured.startDate,
    missing, { boundary: first.occurred_at });
  if (inference.unknown.length || inference.known.length !== missing.length) return inference;
  openingCostEvidence.apply(db, { workspaceId: event.workspaceId,
    actorId: configured.configuredByUserId }, inference);
  return inference;
}

function recordSalesOrderReceivable(db, event, order, fulfilledLines, journalEntryId,
  issueDate, grossMinor, discountMinor, taxMinor, totalMinor) {
  if (!order.customer_id) throw new Error('A fulfilled credit sale needs a customer before receivable can be recorded.');
  const existing = db.prepare(`SELECT * FROM accounting_customer_invoices
    WHERE workspace_id = ? AND sales_order_id = ?`).get(event.workspaceId, order.id);
  const now = nowIso();
  let invoiceId = existing?.id;
  if (!existing) {
    invoiceId = newId('arinv');
    const invoiceNumber = `SALE-${order.order_number}`;
    db.prepare(`INSERT INTO accounting_customer_invoices
      (id, workspace_id, invoice_number, customer_id, sales_order_id, issue_date,
       due_date, status, currency, subtotal_minor, discount_minor, tax_minor,
       total_minor, balance_minor, journal_entry_id, source_key, notes,
       created_by_user_id, created_at, updated_at, opened_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(invoiceId, event.workspaceId, invoiceNumber, order.customer_id, order.id,
        issueDate, order.currency, grossMinor, discountMinor, taxMinor, totalMinor,
        totalMinor, journalEntryId, `sales-order:${order.id}`,
        'Created from fulfilled Sales Order activity. Payment is recorded separately.',
        order.created_by_user_id || null, now, now, now);
  } else {
    db.prepare(`UPDATE accounting_customer_invoices SET
      subtotal_minor = subtotal_minor + ?, discount_minor = discount_minor + ?,
      tax_minor = tax_minor + ?, total_minor = total_minor + ?,
      balance_minor = balance_minor + ?, journal_entry_id = ?, updated_at = ?,
      status = CASE WHEN balance_minor = 0 THEN 'PARTIALLY_PAID' ELSE status END
      WHERE id = ? AND workspace_id = ?`)
      .run(grossMinor, discountMinor, taxMinor, totalMinor, totalMinor,
        journalEntryId, now, invoiceId, event.workspaceId);
  }
  const revenueAccount = ledger.accountBySystemKey(db, event.workspaceId, 'SALES_REVENUE');
  let lineNumber = Number(db.prepare(`SELECT COALESCE(MAX(line_number), 0) AS n
    FROM accounting_customer_invoice_lines WHERE invoice_id = ?`).get(invoiceId).n);
  const insert = db.prepare(`INSERT INTO accounting_customer_invoice_lines
    (id, workspace_id, invoice_id, line_number, description, quantity,
     unit_price_minor, line_total_minor, revenue_account_id, item_id, sku_id,
     sales_order_line_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const entry of fulfilledLines) {
    const lineGross = Number(entry.line.unit_price_minor) * Number(entry.quantity);
    insert.run(newId('arline'), event.workspaceId, invoiceId, ++lineNumber,
      entry.line.description || `Fulfilled ${order.order_number}`, Number(entry.quantity),
      Number(entry.line.unit_price_minor), lineGross, revenueAccount.id,
      entry.line.item_id, entry.line.sku_id, entry.line.id, now);
  }
}

function postTransfer(db, event) {
  const source = db.prepare('SELECT * FROM movements WHERE id = ? AND workspace_id = ?')
    .get(event.sourceRecordId, event.workspaceId);
  if (!source) throw new Error('The inventory transfer movement could not be found.');
  const rows = db.prepare(`SELECT id FROM movements WHERE workspace_id = ? AND group_id = ?
    ORDER BY seq`).all(event.workspaceId, source.group_id);
  const result = costing.transfer(db, { workspaceId: event.workspaceId }, {
    movementIds: rows.map((row) => row.id), sourceType: 'inventory_transfer',
    sourceRecordId: source.group_id,
  });
  return { kind: 'inventory_transfer', noJournalEntry: true,
    movementGroupId: source.group_id, totalCostMinor: result.totalCostMinor || 0, replayed: result.replayed };
}

function postInventoryRemoval(db, event, postingDate) {
  const source = db.prepare(`SELECT * FROM movements WHERE id = ? AND workspace_id = ?`)
    .get(event.sourceRecordId, event.workspaceId);
  if (!source) throw new Error('The inventory change could not be found.');
  const movements = db.prepare(`SELECT m.*, s.item_id FROM movements m
    JOIN skus s ON s.id = m.sku_id
    WHERE m.workspace_id = ? AND m.group_id = ? ORDER BY m.seq`)
    .all(event.workspaceId, source.group_id);
  if (!movements.length || movements.some((row) => Number(row.quantity_delta) >= 0)) {
    throw new Error('Inventory increased without a Purchase Order receipt or another verified cost source. Add the source cost so Foundry can value it; no amount was guessed.');
  }
  if (movements.some((row) => /sold|sale|customer/i.test(String(row.reason_code || '')))) {
    throw new Error('Inventory was marked as sold without a customer order or selling-price record. Add the sale evidence so Foundry can record revenue and product cost together.');
  }
  return inTransaction(db, () => {
    const issued = costing.issue(db, { workspaceId: event.workspaceId }, {
      movementIds: movements.map((row) => row.id), sourceType: 'inventory_removal',
      sourceRecordId: source.group_id,
    });
    const amount = Number(issued.totalCostMinor || 0);
    if (amount <= 0) throw new Error('The removed inventory has no verified cost. Add its original receipt or opening cost; no expense was guessed.');
    const journalLines = [];
    issued.allocations.forEach((allocation) => {
      const movement = movements.find((row) => row.id === allocation.movementId);
      const dimension = { itemId: movement.item_id, skuId: movement.sku_id,
        locationId: movement.location_id, memo: movement.reason_code || movement.notes || 'Inventory removal' };
      journalLines.push({ accountKey: 'INVENTORY_ADJUSTMENTS', debitMinor: allocation.costMinor, ...dimension });
      journalLines.push({ accountKey: 'INVENTORY_ASSET', creditMinor: allocation.costMinor, ...dimension });
    });
    const posted = ledger.post(db, { workspaceId: event.workspaceId, actorId: source.actor_user_id }, {
      postingDate, description: `Inventory removed: ${source.reason_code || 'other reason'}`,
      sourceType: 'inventory_removal', sourceRecordType: 'movement_group',
      sourceRecordId: source.group_id, sourceEventId: event.id,
      sourceKey: `inventory-removal:${source.group_id}`, createdByType: 'SYSTEM',
      metadata: { movementGroupId: source.group_id, reason: source.reason_code || null,
        units: movements.reduce((sum, row) => sum + Math.abs(Number(row.quantity_delta)), 0),
        costMinor: amount },
      lines: journalLines,
    });
    return { journalEntryId: posted.entry.id, replayed: posted.replayed,
      kind: 'inventory_removal', totalCostMinor: amount };
  });
}

function optionalMinor(value, label, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`${label} must be a non-negative whole minor-unit amount.`);
  return amount;
}

function postConnectorSale(db, event, postingDate) {
  const payload = event.payload || {};
  const movementIds = Array.isArray(payload.movementIds) ? payload.movementIds : [];
  const movements = movementIds.map((id) => db.prepare(`SELECT m.*, s.item_id FROM movements m
    JOIN skus s ON s.id = m.sku_id WHERE m.id = ? AND m.workspace_id = ?`).get(id, event.workspaceId));
  if (!movements.length || movements.some((row) => !row || Number(row.quantity_delta) >= 0)) {
    throw new Error('The connector sale has no verified outgoing inventory movement.');
  }
  const units = movements.reduce((sum, row) => sum + Math.abs(Number(row.quantity_delta)), 0);
  const hasGross = payload.grossMinor !== undefined && payload.grossMinor !== null;
  const unitPrice = optionalMinor(payload.unitPriceMinor, 'Connector sale unit price', null);
  const gross = hasGross ? optionalMinor(payload.grossMinor, 'Connector sale gross amount')
    : (unitPrice === null ? null : unitPrice * units);
  if (gross === null || !Number.isSafeInteger(gross)) {
    throw new Error('The connector sale changed stock but did not provide an authoritative gross amount or unit price.');
  }
  const discount = optionalMinor(payload.discountMinor, 'Connector sale discount');
  const tax = optionalMinor(payload.taxMinor, 'Connector sale tax');
  if (discount > gross) throw new Error('The connector sale discount exceeds gross sales.');
  const revenue = gross - discount;
  const receivable = revenue + tax;
  if (receivable <= 0) throw new Error('The connector sale has no positive financial consequence.');
  return inTransaction(db, () => {
    const issued = costing.issue(db, { workspaceId: event.workspaceId }, {
      movementIds, sourceType: 'connector_sale', sourceRecordId: payload.externalEventId,
    });
    const cogs = Number(issued.totalCostMinor || 0);
    const settled = /^(?:paid|captured|cash|settled)$/i.test(String(payload.settlement || ''));
    if (!settled) {
      throw new Error('The direct connector sale did not prove payment. Use a connected Sales Order/customer flow for receivables, or provide a paid/captured settlement status.');
    }
    const first = movements[0];
    const dimension = { itemId: first.item_id, skuId: first.sku_id, locationId: first.location_id };
    const lines = [
      { accountKey: 'CASH', debitMinor: receivable, ...dimension },
    ];
    if (revenue) lines.push({ accountKey: 'SALES_REVENUE', creditMinor: revenue, ...dimension });
    if (tax) lines.push({ accountKey: 'SALES_TAX_PAYABLE', creditMinor: tax, ...dimension });
    if (cogs) lines.push({ accountKey: 'COST_OF_GOODS_SOLD', debitMinor: cogs, ...dimension },
      { accountKey: 'INVENTORY_ASSET', creditMinor: cogs, ...dimension });
    const posted = ledger.post(db, { workspaceId: event.workspaceId }, {
      postingDate, description: `${payload.connectorName || 'Connector'} sale ${payload.reference || payload.externalEventId}`,
      sourceType: 'connector_sale', sourceRecordType: 'connector_event',
      sourceRecordId: payload.externalEventId, sourceEventId: event.id,
      sourceKey: `connector-sale:${payload.connectorId}:${payload.externalEventId}`,
      createdByType: 'SYSTEM', metadata: { connectorId: payload.connectorId,
        externalEventId: payload.externalEventId, grossMinor: gross, discountMinor: discount,
        revenueMinor: revenue, taxMinor: tax, cogsMinor: cogs, units, settlement: 'CASH' },
      lines,
    });
    return { journalEntryId: posted.entry.id, replayed: posted.replayed,
      kind: 'connector_sale', revenueMinor: revenue, taxMinor: tax, cogsMinor: cogs, units };
  });
}

function postConnectorReturn(db, event, postingDate) {
  const payload = event.payload || {};
  if (!payload.originalSaleEventId) {
    throw new Error('The physical return needs the original connector sale event id before Foundry can reverse revenue or COGS.');
  }
  const original = db.prepare(`SELECT * FROM accounting_journal_entries
    WHERE workspace_id = ? AND source_key = ? AND status = 'POSTED'`)
    .get(event.workspaceId, `connector-sale:${payload.connectorId}:${payload.originalSaleEventId}`);
  if (!original) throw new Error('The original connector sale has not been posted to accounting.');
  const originalEntry = ledger.getEntry(db, event.workspaceId, original.id);
  const originalUnits = Number(originalEntry.metadata.units || 0);
  const returnedUnits = Number(payload.quantity || 0);
  if (!Number.isSafeInteger(returnedUnits) || returnedUnits <= 0 || returnedUnits > originalUnits) {
    throw new Error('The returned quantity cannot be matched safely to the original connector sale.');
  }
  const revenue = optionalMinor(payload.revenueMinor, 'Connector refund amount',
    Math.round(Number(originalEntry.metadata.revenueMinor || 0) * returnedUnits / originalUnits));
  const tax = optionalMinor(payload.taxMinor, 'Connector refunded tax',
    Math.round(Number(originalEntry.metadata.taxMinor || 0) * returnedUnits / originalUnits));
  const cogs = Math.round(Number(originalEntry.metadata.cogsMinor || 0) * returnedUnits / originalUnits);
  const actor = db.prepare(`SELECT * FROM users WHERE workspace_id = ? AND role IN ('owner','accountant')
    ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at LIMIT 1`).get(event.workspaceId);
  if (!actor) throw new Error('No authorized accounting user exists for this connector return.');
  const refunded = require('./refunds').refundSale(db,
    { workspaceId: event.workspaceId, actorId: actor.id, accountId: actor.account_id }, actor, {
      originalJournalEntryId: original.id, refundDate: postingDate,
      revenueMinor: revenue, taxMinor: tax, cogsMinor: cogs, physicalReturn: true,
      destination: originalEntry.metadata.settlement === 'CASH' ? 'CASH' : 'AR',
      movementIds: payload.movementIds, reference: payload.reference,
      sourceKey: `connector-return:${payload.connectorId}:${payload.externalEventId}`,
      sourceEventId: event.id, createdByType: 'SYSTEM',
    });
  return { journalEntryId: refunded.entry.id, replayed: refunded.replayed,
    kind: 'connector_return', revenueMinor: revenue, taxMinor: tax, cogsMinor: cogs, units: returnedUnits };
}

function dispatch(db, event, postingDate) {
  if (event.type === 'purchase_order.partially_received' || event.type === 'purchase_order.completed') {
    return postPurchaseReceipt(db, event, postingDate);
  }
  if (event.type === 'sales_order.partially_fulfilled' || event.type === 'sales_order.fulfilled') {
    return postSaleFulfillment(db, event, postingDate);
  }
  if (event.type === 'inventory.transferred' && event.sourceRecordType === 'movement') {
    return postTransfer(db, event);
  }
  if (['inventory.issued', 'inventory.corrected'].includes(event.type)
    && event.sourceRecordType === 'movement') return postInventoryRemoval(db, event, postingDate);
  if (event.type === 'inventory.received') {
    // The physical receipt is valid even when it did not come from Purchasing.
    // Do not turn routine stock handling into a global exception. Accounting's
    // owner read model keeps the units visible and identifies their missing
    // cost evidence by product/location until the owner supplies it.
    return { kind: 'inventory_receipt_without_cost', noJournalEntry: true,
      reason: 'receipt_cost_not_proven',
      message: 'Inventory was received without a Purchase Order or another verified cost source. The units remain visible, but no inventory value was guessed.' };
  }
  if (event.type === 'connector.sale.completed') return postConnectorSale(db, event, postingDate);
  if (event.type === 'connector.return.completed') return postConnectorReturn(db, event, postingDate);
  return null;
}

function captureAndProcess(db, event) {
  // Legacy workspaces are upgraded at the first real operational event. New
  // workspaces are configured at creation, so there is no user-facing switch
  // and no interval in which business activity silently misses Accounting.
  const automatic = require('./automatic');
  const postingDate = eventBusinessDate(db, event);
  const ensured = automatic.ensure(db, event.workspaceId, { startDate: postingDate });
  const configured = ensured.configured;
  if (!configured.enabled || !configured.startDate) return { status: 'NEEDS_REVIEW',
    outcome: { reason: 'accounting_owner_unavailable', message: 'Foundry could not identify an owner or accountant for this workspace.' } };
  const prior = inbox(db, event.workspaceId, event.id);
  if (prior && ['POSTED', 'IGNORED'].includes(prior.status)) return prior;
  if (prior && prior.status === 'NEEDS_REVIEW') return prior;
  const id = prior ? prior.id : newId('aei');
  if (!prior) db.prepare(`INSERT INTO accounting_event_inbox
    (id, workspace_id, domain_event_id, event_type, status, outcome, created_at)
    VALUES (?, ?, ?, ?, 'PENDING', '{}', ?)`)
    .run(id, event.workspaceId, event.id, event.type, nowIso());
  if (postingDate < configured.startDate) {
    const outcome = { reason: 'before_accounting_start_date', postingDate, startDate: configured.startDate };
    setOutcome(db, id, 'IGNORED', outcome);
    return inbox(db, event.workspaceId, event.id);
  }
  if (!AUTOMATIC.has(event.type)) {
    const financiallyRelevant = event.type.startsWith('inventory.')
      || event.type === 'purchase_order.placed' || event.type === 'sales_order.confirmed';
    const outcome = financiallyRelevant
      ? { reason: 'no_posting_until_financial_recognition_or_explicit_cost_evidence' }
      : { reason: 'non_financial_event' };
    setOutcome(db, id, 'IGNORED', outcome);
    return inbox(db, event.workspaceId, event.id);
  }
  try {
    if (event.type === 'sales_order.partially_fulfilled' || event.type === 'sales_order.fulfilled') {
      recoverVerifiedCostBeforeSale(db, event);
    }
    const outcome = dispatch(db, event, postingDate);
    if (!outcome) {
      setOutcome(db, id, 'IGNORED', { reason: 'no_deterministic_adapter_for_event' });
    } else {
      setOutcome(db, id, outcome.journalEntryId ? 'POSTED' : 'IGNORED', outcome, null, outcome.journalEntryId);
    }
  } catch (error) {
    setOutcome(db, id, 'NEEDS_REVIEW', {
      reason: 'accounting_evidence_incomplete', eventType: event.type,
      message: error.message,
    }, error);
  }
  return inbox(db, event.workspaceId, event.id);
}

function retry(db, workspaceId, eventId) {
  const row = inbox(db, workspaceId, eventId);
  if (!row) throw new Error('That accounting event is not waiting for review.');
  db.prepare(`UPDATE accounting_event_inbox SET status = 'PENDING', error_message = NULL,
    processed_at = NULL WHERE id = ?`).run(row.id);
  const domain = require('../manager/events').get(db, workspaceId, eventId);
  return captureAndProcess(db, domain);
}

module.exports = { inbox, captureAndProcess, retry, eventBusinessDate };
