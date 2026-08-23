'use strict';

/**
 * Booking in what actually turned up.
 *
 * Two rules shape everything here.
 *
 * The first: this module never writes a balance. Every unit received goes
 * through the Mission 1 receive operation, with a reference back to the order
 * it came from, so the ledger explains the stock and `verifyIntegrity` still
 * holds. There is no path from a purchase order to a balance that skips the
 * engine.
 *
 * The second: a delivery can only be booked in once. The receipt claims a
 * unique key before any stock moves, so a double-clicked button, a refreshed
 * page or a retried request returns the first receipt instead of receiving the
 * shipment twice — which on a van-load of stock is an expensive mistake to
 * unpick.
 *
 * What arrives rarely matches what was ordered exactly, and both directions are
 * handled honestly: short deliveries leave the order open with the remainder
 * outstanding, and over-deliveries are refused unless someone explicitly says
 * they accepted more, with the discrepancy recorded either way.
 */

const { inTransaction } = require('../db');
const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const engine = require('../domain/inventory-engine');
const repo = require('../domain/repository');
const poService = require('./po-service');

const RECEIPT_NOTE = 'Received against purchase order';

const json = (value, fallback) => {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
};

/** What is still outstanding on an order, ready for a receiving screen. */
/**
 * Retires any outstanding "book this delivery in" work for an order.
 *
 * Wrapped so a workspace without the autopilot tables, or a reminder already
 * dealt with, cannot turn a successful receipt into a failed one. Booking stock
 * in is the important half; tidying the reminder is not worth losing it over.
 */
function closeReceivingReminders(db, workspaceId, purchaseOrderId) {
  try {
    const workItems = require('../autopilot/work-items');
    for (const item of workItems.list(db, workspaceId, { category: 'receiving_followup', limit: 200 })) {
      if (item.isTerminal) continue;
      const orderId = item.purchaseOrderId || (item.recommendedAction || {}).purchaseOrderId;
      if (orderId !== purchaseOrderId) continue;
      workItems.transition(db, workspaceId, item.id, workItems.STATUS.COMPLETED, {
        completedAt: new Date().toISOString(),
        verificationStatus: 'NOT_APPLICABLE',
        outcome: { ...(item.outcome || {}), bookedIn: true, purchaseOrderId },
      });
    }
  } catch { /* the receipt is what matters */ }
}

function outstandingLines(db, workspaceId, poId) {
  const order = poService.get(db, workspaceId, poId);
  return {
    order,
    lines: order.lines.filter((line) => line.outstandingUnits > 0),
  };
}

/**
 * Checks a proposed delivery without receiving any of it.
 *
 * Returns the same shape whether or not it would be accepted, because the
 * receiving screen needs to show the discrepancy *before* someone commits to
 * it — an over-receipt warning that appears afterwards is a complaint, not a
 * check.
 */
function preview(db, workspaceId, poId, input) {
  const order = poService.get(db, workspaceId, poId);
  const requested = normaliseLines(order, input.lines);

  const lines = requested.map((entry) => {
    const overBy = Math.max(0, entry.quantityUnits - entry.line.outstandingUnits);
    return {
      ...entry,
      overBy,
      isOver: overBy > 0,
      remainingAfter: Math.max(0, entry.line.outstandingUnits - entry.quantityUnits),
    };
  });

  const overLines = lines.filter((line) => line.isOver);
  const totalUnits = lines.reduce((sum, line) => sum + line.quantityUnits, 0);
  const outstandingAfter = order.lines.reduce((sum, line) => {
    const received = lines.filter((l) => l.line.id === line.id).reduce((n, l) => n + l.quantityUnits, 0);
    return sum + Math.max(0, line.outstandingUnits - received);
  }, 0);

  return {
    order,
    lines,
    totalUnits,
    outstandingAfter,
    overLines,
    requiresOverReceiptApproval: overLines.length > 0,
    willComplete: outstandingAfter === 0 && overLines.length === 0,
    warnings: overLines.map(
      (line) =>
        `This receipt is ${line.overBy} ${line.line.unitLabel}(s) above the purchase order for ${line.line.displayName}.`
    ),
  };
}

/** Turns whatever the caller sent into checked, resolved line requests. */
function normaliseLines(order, rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new ValidationError('Say how much of the order arrived.');
  }

  const out = [];
  for (const raw of rawLines) {
    const line = order.lines.find((l) => l.id === raw.lineId);
    if (!line) throw new NotFoundError('That line is not on this purchase order.');

    // Quantities may be given in the supplier's packs or in inventory units;
    // a delivery note usually says "4 cases".
    let units;
    if (raw.quantityPurchaseUnits !== undefined && raw.quantityPurchaseUnits !== null && raw.quantityPurchaseUnits !== '') {
      units = Math.trunc(Number(raw.quantityPurchaseUnits)) * line.unitsPerPurchaseUnit;
    } else {
      units = Math.trunc(Number(raw.quantityUnits));
    }
    if (!Number.isFinite(units) || units < 0) {
      throw new ValidationError(`How many ${line.unitLabel}s of ${line.displayName} arrived?`);
    }
    if (units === 0) continue;

    const serials = Array.isArray(raw.serials)
      ? raw.serials.map((s) => String(s).trim()).filter(Boolean)
      : String(raw.serials || '')
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean);

    if (line.trackingMode === 'serial') {
      if (serials.length === 0) {
        throw new ValidationError(`${line.displayName} is tracked by serial number — list the ones that arrived.`);
      }
      // The serials are the quantity. Believing a typed number over the actual
      // list would create units with no identity.
      units = serials.length;
    }
    if (line.trackingMode === 'lot' && !trimOrNull(raw.lotCode)) {
      throw new ValidationError(`${line.displayName} is tracked by lot — which batch arrived?`);
    }

    out.push({
      line,
      quantityUnits: units,
      quantityPurchaseUnits: Math.round((units / line.unitsPerPurchaseUnit) * 100) / 100,
      lotCode: trimOrNull(raw.lotCode),
      expiresAt: trimOrNull(raw.expiresAt),
      serials,
      locationId: raw.locationId || line.destinationLocationId || order.destinationLocationId,
    });
  }

  if (out.length === 0) throw new ValidationError('Nothing was marked as arrived.');
  return out;
}

/**
 * Books a delivery in.
 *
 * @param {string} idempotencyKey the same key retried returns the first receipt.
 */
function receive(db, ctx, membership, poId, input = {}) {
  permissions.assertCan(membership, permissions.RECEIVE_PO, 'book in deliveries');
  const order = poService.get(db, ctx.workspaceId, poId);

  const idempotencyKey = input.idempotencyKey || `po-receipt:${poId}:${nowIso()}`;

  // The replay check comes before every other guard, on purpose. A resubmitted
  // form arrives after the stock is already in and the order has closed, and
  // answering that with "already received in full" reads as an error for
  // something that worked. The honest answer to "book this in" when it is
  // already booked in is the receipt.
  const seen = db
    .prepare('SELECT * FROM purchase_order_receipts WHERE workspace_id = ? AND idempotency_key = ?')
    .get(ctx.workspaceId, idempotencyKey);
  if (seen) {
    return {
      replayed: true,
      receipt: hydrateReceipt(db, ctx.workspaceId, seen.id),
      order: poService.get(db, ctx.workspaceId, poId),
    };
  }

  if (order.status === poService.STATUS.CANCELLED) {
    throw new ValidationError('That order was cancelled. Reopen or re-order it before receiving anything.');
  }
  if (!poService.OPEN.includes(order.status)) {
    if (order.status === poService.STATUS.RECEIVED) {
      throw new ValidationError('That order has already been received in full.');
    }
    throw new ValidationError('That order has not been approved yet, so nothing can be received against it.');
  }

  const checked = preview(db, ctx.workspaceId, poId, input);
  if (checked.requiresOverReceiptApproval && input.approveOverReceipt !== true) {
    const problem = new ValidationError(
      `${checked.warnings[0]} Confirm that you want to accept the extra, or correct the quantity.`,
      { field: 'quantity' }
    );
    problem.overReceipt = checked.overLines.map((line) => ({
      lineId: line.line.id,
      displayName: line.line.displayName,
      ordered: line.line.quantityUnits,
      alreadyReceived: line.line.quantityReceivedUnits,
      arriving: line.quantityUnits,
      overBy: line.overBy,
    }));
    throw problem;
  }

  const now = nowIso();
  const receiptId = newId('porc');

  return inTransaction(db, () => {
    // Claiming the key inside the same transaction as the movements is what
    // makes "received twice" impossible rather than merely unlikely.
    try {
      db.prepare(
        `INSERT INTO purchase_order_receipts (
           id, workspace_id, purchase_order_id, idempotency_key, received_by_user_id, received_at,
           reference, note, over_receipt_approved, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        receiptId, ctx.workspaceId, poId, idempotencyKey, ctx.actorId,
        trimOrNull(input.receivedAt) || now, trimOrNull(input.reference), trimOrNull(input.note),
        checked.requiresOverReceiptApproval ? 1 : 0, now
      );
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
        const raced = db
          .prepare('SELECT * FROM purchase_order_receipts WHERE workspace_id = ? AND idempotency_key = ?')
          .get(ctx.workspaceId, idempotencyKey);
        if (raced) {
          return {
            replayed: true,
            receipt: hydrateReceipt(db, ctx.workspaceId, raced.id),
            order: poService.get(db, ctx.workspaceId, poId),
          };
        }
      }
      throw error;
    }

    const groupIds = [];
    for (const entry of checked.lines) {
      const location = repo.requireLocation(db, ctx.workspaceId, entry.locationId, 'destination location');
      const reference = `${order.poNumber}`;

      // Mission 1 does the actual work. This is the only way stock arrives.
      const movement = engine.receive(db, ctx, {
        skuId: entry.line.skuId,
        locationId: location.id,
        quantity: entry.line.trackingMode === 'serial' ? undefined : entry.quantityUnits,
        serials: entry.line.trackingMode === 'serial' ? entry.serials : undefined,
        lotCode: entry.line.trackingMode === 'lot' ? entry.lotCode : undefined,
        expiresAt: entry.line.trackingMode === 'lot' ? entry.expiresAt : undefined,
        notes: RECEIPT_NOTE,
        reference,
      });
      groupIds.push(movement.groupId);

      db.prepare(
        `INSERT INTO purchase_order_receipt_lines (
           id, workspace_id, receipt_id, purchase_order_line_id, sku_id, location_id,
           quantity_units, lot_id, lot_code, expires_at, serials, over_by_units, movement_ids, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        newId('porl'), ctx.workspaceId, receiptId, entry.line.id, entry.line.skuId, location.id,
        movement.quantity, movement.lotId || null, entry.lotCode, entry.expiresAt,
        JSON.stringify(entry.serials), entry.overBy, JSON.stringify(movement.movementIds), now
      );

      db.prepare(
        'UPDATE purchase_order_lines SET quantity_received_units = quantity_received_units + ? WHERE id = ?'
      ).run(movement.quantity, entry.line.id);
    }

    const after = poService.get(db, ctx.workspaceId, poId);
    const status = after.outstandingUnits === 0
      ? poService.STATUS.RECEIVED
      : poService.STATUS.PARTIALLY_RECEIVED;

    db.prepare(
      `UPDATE purchase_orders SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`
    ).run(
      status,
      status === poService.STATUS.RECEIVED ? now : null,
      now,
      poId,
      ctx.workspaceId
    );

    // A reminder to book in a delivery is finished when the delivery is booked
    // in, whichever screen did it. Left open, "PO-1001 is late" stayed in Needs
    // you after the stock had arrived and been counted — the queue telling
    // somebody to do a job they had just done.
    if (status === poService.STATUS.RECEIVED) closeReceivingReminders(db, ctx.workspaceId, poId);

    const result = {
      unitsReceived: checked.totalUnits,
      lines: checked.lines.length,
      outstandingAfter: after.outstandingUnits,
      status,
      overReceipt: checked.requiresOverReceiptApproval,
    };
    db.prepare('UPDATE purchase_order_receipts SET movement_group_ids = ?, result = ? WHERE id = ?')
      .run(JSON.stringify(groupIds), JSON.stringify(result), receiptId);

    poService.recordEvent(db, ctx.workspaceId, poId, 'received', result, ctx.actorId);

    return {
      replayed: false,
      receipt: hydrateReceipt(db, ctx.workspaceId, receiptId),
      order: poService.get(db, ctx.workspaceId, poId),
      result,
    };
  });
}

function hydrateReceipt(db, workspaceId, receiptId) {
  const row = db
    .prepare(
      `SELECT r.*, u.name AS received_by_name FROM purchase_order_receipts r
         LEFT JOIN users u ON u.id = r.received_by_user_id
        WHERE r.id = ? AND r.workspace_id = ?`
    )
    .get(receiptId, workspaceId);
  if (!row) return null;

  const lines = db
    .prepare(
      `SELECT rl.*, i.name AS item_name, sk.variant_label, loc.name AS location_name
         FROM purchase_order_receipt_lines rl
         JOIN skus sk ON sk.id = rl.sku_id
         JOIN items i ON i.id = sk.item_id
         JOIN locations loc ON loc.id = rl.location_id
        WHERE rl.receipt_id = ?
        ORDER BY rl.rowid`
    )
    .all(receiptId)
    .map((line) => ({
      id: line.id,
      lineId: line.purchase_order_line_id,
      skuId: line.sku_id,
      displayName: line.variant_label ? `${line.item_name} / ${line.variant_label}` : line.item_name,
      locationId: line.location_id,
      locationName: line.location_name,
      quantityUnits: line.quantity_units,
      lotCode: line.lot_code,
      expiresAt: line.expires_at,
      serials: json(line.serials, []),
      overByUnits: line.over_by_units,
      movementIds: json(line.movement_ids, []),
    }));

  return {
    id: row.id,
    purchaseOrderId: row.purchase_order_id,
    receivedAt: row.received_at,
    receivedByName: row.received_by_name,
    reference: row.reference,
    note: row.note,
    overReceiptApproved: Boolean(row.over_receipt_approved),
    movementGroupIds: json(row.movement_group_ids, []),
    result: json(row.result, {}),
    lines,
    totalUnits: lines.reduce((sum, line) => sum + line.quantityUnits, 0),
  };
}

function receiptsFor(db, workspaceId, poId) {
  return db
    .prepare(
      'SELECT id FROM purchase_order_receipts WHERE workspace_id = ? AND purchase_order_id = ? ORDER BY received_at, rowid'
    )
    .all(workspaceId, poId)
    .map((row) => hydrateReceipt(db, workspaceId, row.id));
}

/**
 * Verifies a receipt against Mission 1 truth.
 *
 * "It was received" and "the stock is there" are separate claims, exactly as
 * they are for a Mission 4 action.
 */
function verifyReceipt(db, workspaceId, receiptId) {
  const receipt = hydrateReceipt(db, workspaceId, receiptId);
  if (!receipt) throw new NotFoundError('That receipt is not in this inventory.');

  const checks = receipt.lines.map((line) => {
    const movements = line.movementIds.length
      ? db
          .prepare(
            `SELECT COALESCE(SUM(quantity_delta), 0) AS units, COUNT(*) AS n FROM movements
              WHERE workspace_id = ? AND id IN (${line.movementIds.map(() => '?').join(',')})`
          )
          .get(workspaceId, ...line.movementIds)
      : { units: 0, n: 0 };
    return {
      name: line.displayName,
      expected: line.quantityUnits,
      observed: movements.units,
      ok: movements.units === line.quantityUnits,
    };
  });

  return {
    receiptId,
    verified: checks.every((check) => check.ok),
    checks,
    problems: checks.filter((c) => !c.ok).map((c) => `${c.name}: expected ${c.expected}, found ${c.observed}.`),
  };
}

module.exports = {
  RECEIPT_NOTE,
  outstandingLines,
  preview,
  normaliseLines,
  receive,
  hydrateReceipt,
  receiptsFor,
  verifyReceipt,
};
