'use strict';

/**
 * Purchase orders: what we intend to buy, and what a person committed to.
 *
 * A PO follows the Mission 4 philosophy, because it is the same kind of thing:
 * something consequential that Foundry may prepare but never execute on its
 * own. Foundry drafts; a person with the right permission approves; the
 * approval is recorded against exactly what was on the screen, by hash.
 *
 * Approval is where a PO stops being editable in the ways that matter. The
 * receiving screen checks deliveries against ordered quantities, so quietly
 * changing a quantity after approval would make both the approval and every
 * over-receipt warning meaningless.
 *
 * Nothing here writes stock. Receiving does that, through Mission 1.
 */

const crypto = require('crypto');
const { inTransaction } = require('../db');
const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const repo = require('../domain/repository');
const supplierService = require('./supplier-service');
const { addLocalDays } = require('../lib/calendar');
const managerEvents = require('../manager/events');
const supplierCommunications = require('./supplier-communications');

const STATUS = {
  DRAFT: 'DRAFT',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  APPROVED: 'APPROVED',
  ORDERED: 'ORDERED',
  PARTIALLY_RECEIVED: 'PARTIALLY_RECEIVED',
  RECEIVED: 'RECEIVED',
  CANCELLED: 'CANCELLED',
};

/** Statuses a person may still edit or delete the order in. */
const EDITABLE = [STATUS.DRAFT, STATUS.AWAITING_APPROVAL];
/** Statuses where stock is still expected to arrive. */
const OPEN = [STATUS.APPROVED, STATUS.ORDERED, STATUS.PARTIALLY_RECEIVED];
/** Statuses that can still be cancelled. */
const CANCELLABLE = [...EDITABLE, STATUS.APPROVED, STATUS.ORDERED, STATUS.PARTIALLY_RECEIVED];

const DAY_MS = 24 * 60 * 60 * 1000;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** A hash over what is being committed to, and nothing presentational. */
function computeIntegrityHash(order) {
  return crypto
    .createHash('sha256')
    .update(
      stableStringify({
        supplierId: order.supplierId,
        expectedDate: order.expectedDate || null,
        destinationLocationId: order.destinationLocationId || null,
        lines: (order.lines || []).map((line) => ({
          skuId: line.skuId,
          quantityUnits: line.quantityUnits,
          quantityPurchaseUnits: line.quantityPurchaseUnits,
          unitCost: line.unitCost ?? null,
        })),
      })
    )
    .digest('hex');
}

const json = (value, fallback) => {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
};

function hydrateLine(row) {
  if (!row) return null;
  const outstanding = Math.max(0, row.quantity_units - row.quantity_received_units);
  return {
    id: row.id,
    lineNumber: row.line_number,
    skuId: row.sku_id,
    supplierItemId: row.supplier_item_id,
    supplierSku: row.supplier_sku,
    description: row.description,
    itemName: row.item_name,
    variantLabel: row.variant_label,
    displayName: row.variant_label ? `${row.item_name} / ${row.variant_label}` : row.item_name,
    unitLabel: row.unit_label,
    trackingMode: row.tracking_mode,
    purchaseUnit: row.purchase_unit,
    unitsPerPurchaseUnit: row.units_per_purchase_unit,
    quantityPurchaseUnits: row.quantity_purchase_units,
    quantityUnits: row.quantity_units,
    quantityReceivedUnits: row.quantity_received_units,
    outstandingUnits: outstanding,
    isComplete: outstanding === 0,
    unitCost: row.unit_cost,
    lineTotal: row.line_total,
    destinationLocationId: row.destination_location_id,
    destinationLocationName: row.destination_location_name,
    notes: row.notes,
  };
}

const LINE_SELECT = `
  SELECT l.*, i.name AS item_name, sk.variant_label, i.unit_label, i.tracking_mode,
         loc.name AS destination_location_name
    FROM purchase_order_lines l
    JOIN skus sk ON sk.id = l.sku_id
    JOIN items i ON i.id = sk.item_id
    LEFT JOIN locations loc ON loc.id = l.destination_location_id`;

function hydrate(db, row) {
  if (!row) return null;
  const lines = db
    .prepare(`${LINE_SELECT} WHERE l.purchase_order_id = ? ORDER BY l.line_number`)
    .all(row.id)
    .map(hydrateLine);

  const subtotal = lines.reduce((sum, line) => sum + (line.lineTotal || 0), 0);
  const outstandingUnits = lines.reduce((sum, line) => sum + line.outstandingUnits, 0);
  const orderedUnits = lines.reduce((sum, line) => sum + line.quantityUnits, 0);
  const receivedUnits = lines.reduce((sum, line) => sum + line.quantityReceivedUnits, 0);

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    poNumber: row.po_number,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    supplierItemCodeLabel: row.item_code_label || 'Supplier code',
    supplierEmail: row.supplier_email,
    supplierContact: row.supplier_contact,
    status: row.status,
    orderDate: row.order_date,
    expectedDate: row.expected_date,
    expectedDateSource: row.expected_date_source,
    destinationLocationId: row.destination_location_id,
    destinationLocationName: row.destination_location_name,
    currency: row.currency,
    notes: row.notes,
    source: row.source,
    sourceDetail: json(row.source_detail, {}),
    createdByUserId: row.created_by_user_id,
    approvedByUserId: row.approved_by_user_id,
    cancelledByUserId: row.cancelled_by_user_id,
    cancelReason: row.cancel_reason,
    integrityHash: row.integrity_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at,
    orderedAt: row.ordered_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    lines,
    subtotal: Math.round(subtotal * 100) / 100,
    orderedUnits,
    receivedUnits,
    outstandingUnits,
    isOpen: OPEN.includes(row.status),
    isEditable: EDITABLE.includes(row.status),
    canCancel: CANCELLABLE.includes(row.status),
    hasCosts: lines.some((line) => line.unitCost !== null && line.unitCost !== undefined),
  };
}

const ORDER_SELECT = `
  SELECT po.*, s.name AS supplier_name, s.email AS supplier_email, s.contact_name AS supplier_contact,
         s.item_code_label,
         loc.name AS destination_location_name
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN locations loc ON loc.id = po.destination_location_id`;

function get(db, workspaceId, poId) {
  const row = db.prepare(`${ORDER_SELECT} WHERE po.id = ? AND po.workspace_id = ?`).get(poId, workspaceId);
  if (!row) throw new NotFoundError('That purchase order is not in this inventory.');
  return hydrate(db, row);
}

function find(db, workspaceId, poId) {
  const row = db.prepare(`${ORDER_SELECT} WHERE po.id = ? AND po.workspace_id = ?`).get(poId, workspaceId);
  return row ? hydrate(db, row) : null;
}

function findByNumber(db, workspaceId, poNumber) {
  const row = db
    .prepare(`${ORDER_SELECT} WHERE po.workspace_id = ? AND po.po_number = ? COLLATE NOCASE`)
    .get(workspaceId, String(poNumber || '').trim());
  return row ? hydrate(db, row) : null;
}

function list(db, workspaceId, { status = null, supplierId = null, limit = 50 } = {}) {
  const clauses = ['po.workspace_id = ?'];
  const params = [workspaceId];
  if (status) {
    const statuses = Array.isArray(status) ? status : [status];
    clauses.push(`po.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (supplierId) {
    clauses.push('po.supplier_id = ?');
    params.push(supplierId);
  }
  return db
    .prepare(`${ORDER_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY po.created_at DESC, po.rowid DESC LIMIT ?`)
    .all(...params, limit)
    .map((row) => hydrate(db, row));
}

/** The next PO number for this workspace: PO-1001, PO-1002, … */
function nextNumber(db, workspaceId) {
  const rows = db
    .prepare("SELECT po_number FROM purchase_orders WHERE workspace_id = ? AND po_number LIKE 'PO-%'")
    .all(workspaceId);
  let highest = 1000;
  for (const row of rows) {
    const n = Number(String(row.po_number).replace(/^PO-/i, ''));
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return `PO-${highest + 1}`;
}

function recordEvent(db, workspaceId, poId, event, detail, actorUserId) {
  db.prepare(
    `INSERT INTO purchase_order_events (id, workspace_id, purchase_order_id, event, detail, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(newId('poev'), workspaceId, poId, event, JSON.stringify(detail || {}), actorUserId || null, nowIso());
}

function eventsFor(db, workspaceId, poId) {
  return db
    .prepare(
      `SELECT e.*, u.name AS actor_name FROM purchase_order_events e
         LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.workspace_id = ? AND e.purchase_order_id = ?
        ORDER BY e.created_at, e.rowid`
    )
    .all(workspaceId, poId)
    .map((row) => ({
      event: row.event,
      detail: json(row.detail, {}),
      actorName: row.actor_name,
      createdAt: row.created_at,
    }));
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

/**
 * Works out the expected arrival date, and where the date came from.
 *
 * Provenance matters as much as the date: Foundry will later call an order
 * late, and doing that against a date it invented would be an accusation it
 * cannot support.
 */
function resolveExpectedDate(db, workspaceId, supplier, lines, input, now) {
  if (input.expectedDate) {
    return { expectedDate: String(input.expectedDate).slice(0, 10), source: 'manual' };
  }
  const leadTimes = lines
    .map((line) => line.leadTimeDays)
    .filter((days) => days !== null && days !== undefined);
  if (leadTimes.length) {
    const longest = Math.max(...leadTimes);
    return {
      expectedDate: addLocalDays(now, longest),
      source: 'supplier_item',
    };
  }
  if (supplier.defaultLeadTimeDays) {
    return {
      expectedDate: addLocalDays(now, supplier.defaultLeadTimeDays),
      source: 'supplier_default',
    };
  }
  return { expectedDate: null, source: 'unknown' };
}

/**
 * Creates a draft order.
 *
 * @param {object} input { supplierId, lines: [{ skuId, quantityPurchaseUnits | quantityUnits, unitCost }], … }
 */
function createOrder(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.CREATE_PO, 'prepare purchase orders');
  const now = Date.now();
  const nowText = nowIso();
  const supplier = supplierService.getSupplier(db, ctx.workspaceId, input.supplierId);
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new ValidationError('A purchase order needs at least one line.');
  }

  // An explicit destination applies to the whole order. Without one, each line
  // goes where that product is actually kept and used rather than to a single
  // order-wide default, which sent replenishment for a product that only ever
  // sells from the roastery to the warehouse instead.
  const destination = input.destinationLocationId
    ? repo.requireLocation(db, ctx.workspaceId, input.destinationLocationId, 'destination location')
    : null;

  // Resolve every line before writing anything, so a bad line fails the whole
  // order rather than leaving half of one behind.
  const resolved = input.lines.map((line, index) => {
    const sku = repo.requireSku(db, ctx.workspaceId, line.skuId);
    const supplierItem = db
      .prepare('SELECT * FROM supplier_items WHERE workspace_id = ? AND supplier_id = ? AND sku_id = ?')
      .get(ctx.workspaceId, supplier.id, sku.id);

    const purchaseUnit = trimOrNull(line.purchaseUnit) || (supplierItem ? supplierItem.purchase_unit : 'unit');
    const unitsPer = Number(
      line.unitsPerPurchaseUnit ?? (supplierItem ? supplierItem.units_per_purchase_unit : 1)
    );
    if (!Number.isInteger(unitsPer) || unitsPer < 1) {
      throw new ValidationError(`Line ${index + 1}: the pack size must be a whole number of units.`);
    }

    let purchaseUnits;
    let units;
    if (line.quantityPurchaseUnits !== undefined && line.quantityPurchaseUnits !== null && line.quantityPurchaseUnits !== '') {
      purchaseUnits = Math.trunc(Number(line.quantityPurchaseUnits));
      units = purchaseUnits * unitsPer;
    } else {
      units = Math.trunc(Number(line.quantityUnits));
      purchaseUnits = Math.ceil(units / unitsPer);
      // Ordering in packs means the real quantity is the whole packs, always.
      units = purchaseUnits * unitsPer;
    }
    if (!Number.isFinite(purchaseUnits) || purchaseUnits <= 0) {
      throw new ValidationError(`Line ${index + 1}: how many ${purchaseUnit}s?`);
    }

    const unitCost =
      line.unitCost === undefined || line.unitCost === null || line.unitCost === ''
        ? (supplierItem ? supplierItem.last_unit_cost : null)
        : Number(line.unitCost);
    if (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0)) {
      throw new ValidationError(`Line ${index + 1}: the unit cost is not an amount.`);
    }

    const lineDestination = line.destinationLocationId
      ? repo.requireLocation(db, ctx.workspaceId, line.destinationLocationId, 'destination location')
      : destination || destinationForSku(db, ctx.workspaceId, sku.id);

    return {
      skuId: sku.id,
      supplierItemId: supplierItem ? supplierItem.id : null,
      supplierSku: trimOrNull(line.supplierSku) || (supplierItem ? supplierItem.supplier_sku : null),
      description: trimOrNull(line.description) || (supplierItem ? supplierItem.supplier_description : null),
      purchaseUnit,
      unitsPerPurchaseUnit: unitsPer,
      quantityPurchaseUnits: purchaseUnits,
      quantityUnits: units,
      unitCost,
      lineTotal: unitCost === null ? null : Math.round(unitCost * units * 100) / 100,
      destinationLocationId: lineDestination ? lineDestination.id : null,
      leadTimeDays: supplierItem
        ? supplierItem.lead_time_days ?? supplier.defaultLeadTimeDays
        : supplier.defaultLeadTimeDays,
      notes: trimOrNull(line.notes),
    };
  });

  const { expectedDate, source: expectedSource } = resolveExpectedDate(
    db, ctx.workspaceId, supplier, resolved, input, now
  );

  return inTransaction(db, () => {
    const id = newId('po');
    const poNumber = trimOrNull(input.poNumber) || nextNumber(db, ctx.workspaceId);
    const status = input.status === STATUS.AWAITING_APPROVAL ? STATUS.AWAITING_APPROVAL : STATUS.DRAFT;

    db.prepare(
      `INSERT INTO purchase_orders (
         id, workspace_id, po_number, supplier_id, status, order_date, expected_date, expected_date_source,
         destination_location_id, currency, notes, source, source_detail,
         created_by_user_id, integrity_hash, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, ctx.workspaceId, poNumber, supplier.id, status,
      trimOrNull(input.orderDate) || nowText.slice(0, 10), expectedDate, expectedSource,
      // The header keeps a destination when every line agrees on one, so an
      // order that all lands in one place still reads that way.
      (destination && destination.id) || headerDestinationId(resolved), supplier.currency, trimOrNull(input.notes),
      ['manual', 'foundry_recommendation', 'instruction'].includes(input.source) ? input.source : 'manual',
      JSON.stringify(input.sourceDetail || {}),
      ctx.actorId, '', nowText, nowText
    );

    resolved.forEach((line, index) => {
      db.prepare(
        `INSERT INTO purchase_order_lines (
           id, workspace_id, purchase_order_id, line_number, sku_id, supplier_item_id, supplier_sku, description,
           purchase_unit, units_per_purchase_unit, quantity_purchase_units, quantity_units,
           unit_cost, line_total, destination_location_id, notes, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        newId('pol'), ctx.workspaceId, id, index + 1, line.skuId, line.supplierItemId, line.supplierSku,
        line.description, line.purchaseUnit, line.unitsPerPurchaseUnit, line.quantityPurchaseUnits,
        line.quantityUnits, line.unitCost, line.lineTotal, line.destinationLocationId, line.notes, nowText
      );
    });

    const order = get(db, ctx.workspaceId, id);
    const hash = computeIntegrityHash(order);
    db.prepare('UPDATE purchase_orders SET integrity_hash = ? WHERE id = ?').run(hash, id);
    recordEvent(db, ctx.workspaceId, id, 'created', {
      source: order.source,
      lines: order.lines.length,
      subtotal: order.subtotal,
    }, ctx.actorId);

    const prepared = get(db, ctx.workspaceId, id);
    supplierCommunications.prepareForOrder(db, ctx.workspaceId, prepared);
    return prepared;
  });
}

/** One destination for the order only when every line shares it. */
function headerDestinationId(lines) {
  const ids = new Set(lines.map((line) => line.destinationLocationId).filter(Boolean));
  return ids.size === 1 ? [...ids][0] : null;
}

/**
 * Where replenishment for one product should actually land.
 *
 * Falling back to "whichever location is a warehouse" is fine when nobody has
 * said anything at all, but it is the wrong answer for a line Foundry raised
 * itself: the shortage was measured at a particular location, and sending the
 * stock somewhere else leaves that location short, the order looking filled,
 * and somebody transferring it by hand afterwards. A roastery that sells every
 * bag from the roastery should not have its coffee delivered to the warehouse
 * because the warehouse is called a warehouse.
 *
 * Demand comes first — the place stock has most recently left from is the place
 * that needs more — then the place holding the most of it, then the old default.
 */
function destinationForSku(db, workspaceId, skuId) {
  const wentFrom = db
    .prepare(
      `SELECT location_id FROM movements
        WHERE workspace_id = ? AND sku_id = ? AND operation = 'issue'
        ORDER BY occurred_at DESC, seq DESC LIMIT 1`
    )
    .get(workspaceId, skuId);
  if (wentFrom) return repo.requireLocation(db, workspaceId, wentFrom.location_id);

  const holdsMost = db
    .prepare(
      `SELECT location_id FROM balances
        WHERE workspace_id = ? AND sku_id = ? AND on_hand > 0
        ORDER BY on_hand DESC LIMIT 1`
    )
    .get(workspaceId, skuId);
  if (holdsMost) return repo.requireLocation(db, workspaceId, holdsMost.location_id);

  return defaultDestination(db, workspaceId);
}

/** Somewhere sensible for stock to land when nobody said. */
function defaultDestination(db, workspaceId) {
  const locations = repo.listLocations(db, workspaceId).filter((l) => l.is_active);
  if (locations.length === 0) return null;
  if (locations.length === 1) return locations[0];
  return locations.find((l) => l.kind === 'warehouse') || locations[0];
}

/** Sends a draft for approval — the point where it stops being a scratchpad. */
function submitForApproval(db, ctx, membership, poId) {
  permissions.assertCan(membership, permissions.CREATE_PO, 'prepare purchase orders');
  const order = get(db, ctx.workspaceId, poId);
  if (order.status !== STATUS.DRAFT) {
    throw new ValidationError('Only a draft can be sent for approval.');
  }
  db.prepare('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(STATUS.AWAITING_APPROVAL, nowIso(), poId, ctx.workspaceId);
  recordEvent(db, ctx.workspaceId, poId, 'submitted', {}, ctx.actorId);
  return get(db, ctx.workspaceId, poId);
}

/**
 * Approval. Committing to spend money, so it checks that what is being
 * approved is still what was on the screen.
 */
function approve(db, ctx, membership, poId, { expectedHash = null, markOrdered = true } = {}) {
  permissions.assertCan(membership, permissions.APPROVE_PO, 'approve purchase orders');
  const before = get(db, ctx.workspaceId, poId);
  if (![STATUS.DRAFT, STATUS.AWAITING_APPROVAL].includes(before.status)) {
    // Approving twice is not an error worth an alarm: the second one is asking
    // for a state the order is already in.
    if ([STATUS.APPROVED, STATUS.ORDERED].includes(before.status)) return before;
    throw new ValidationError(`A ${before.status.toLowerCase().replace('_', ' ')} order cannot be approved.`);
  }
  const current = computeIntegrityHash(before);
  if (expectedHash && expectedHash !== current) {
    throw new ValidationError('This order changed since you looked at it. Check it again before approving.');
  }

  const now = nowIso();
  const status = markOrdered ? STATUS.ORDERED : STATUS.APPROVED;
  db.prepare(
    `UPDATE purchase_orders
        SET status = ?, approved_by_user_id = ?, approved_at = ?, ordered_at = ?, integrity_hash = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status IN (?, ?)`
  ).run(
    status, ctx.actorId, now, markOrdered ? now : null, current, now,
    poId, ctx.workspaceId, STATUS.DRAFT, STATUS.AWAITING_APPROVAL
  );
  recordEvent(db, ctx.workspaceId, poId, 'approved', { subtotal: before.subtotal, status }, ctx.actorId);
  const approved = get(db, ctx.workspaceId, poId);
  if (markOrdered) supplierCommunications.queueForOrder(db, ctx.workspaceId, approved.id);
  managerEvents.publish(db, ctx.workspaceId, managerEvents.TYPES.PURCHASE_ORDER_PLACED, {
    purchaseOrderId: approved.id,
    poNumber: approved.poNumber,
    skuIds: approved.lines.map((line) => line.skuId),
    outstandingUnits: approved.outstandingUnits,
  }, {
    source: 'purchasing',
    sourceRecordType: 'purchase_order',
    sourceRecordId: `${approved.id}:${approved.updatedAt}`,
  });
  return approved;
}

/**
 * Cancels what has not arrived.
 *
 * Stock already received stays received. A cancellation says "nothing more is
 * coming", and reversing real movements because an order was later cancelled
 * would falsify inventory that physically exists.
 */
function cancel(db, ctx, membership, poId, { reason = null } = {}) {
  permissions.assertCan(membership, permissions.APPROVE_PO, 'cancel purchase orders');
  const order = get(db, ctx.workspaceId, poId);
  if (order.status === STATUS.CANCELLED) return order;
  if (order.status === STATUS.RECEIVED) {
    throw new ValidationError('That order has already been received in full.');
  }
  if (!CANCELLABLE.includes(order.status)) {
    throw new ValidationError('That order cannot be cancelled.');
  }

  const now = nowIso();
  db.prepare(
    `UPDATE purchase_orders
        SET status = ?, cancelled_by_user_id = ?, cancelled_at = ?, cancel_reason = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`
  ).run(STATUS.CANCELLED, ctx.actorId, now, trimOrNull(reason), now, poId, ctx.workspaceId);

  recordEvent(db, ctx.workspaceId, poId, 'cancelled', {
    reason: trimOrNull(reason),
    receivedUnits: order.receivedUnits,
    cancelledUnits: order.outstandingUnits,
  }, ctx.actorId);

  const cancelled = get(db, ctx.workspaceId, poId);
  managerEvents.publish(db, ctx.workspaceId, managerEvents.TYPES.PURCHASE_ORDER_CANCELLED, {
    purchaseOrderId: cancelled.id,
    skuIds: cancelled.lines.map((line) => line.skuId),
  }, {
    source: 'purchasing',
    sourceRecordType: 'purchase_order',
    sourceRecordId: `${cancelled.id}:${cancelled.updatedAt}`,
  });
  return cancelled;
}

/** Removes a draft entirely. Only ever a draft. */
function deleteDraft(db, ctx, membership, poId) {
  permissions.assertCan(membership, permissions.CREATE_PO, 'prepare purchase orders');
  const order = get(db, ctx.workspaceId, poId);
  if (order.status !== STATUS.DRAFT) throw new ValidationError('Only a draft can be deleted.');
  db.prepare('DELETE FROM purchase_orders WHERE id = ? AND workspace_id = ?').run(poId, ctx.workspaceId);
  return { deleted: true, poNumber: order.poNumber };
}

// ---------------------------------------------------------------------------
// Cost history
// ---------------------------------------------------------------------------

/**
 * What this product has actually cost, order by order.
 *
 * Purchasing history, not valuation: these are the prices agreed on orders that
 * were committed to, in the order they were committed. Nothing here values
 * stock on hand or touches accounting.
 */
function costHistory(db, workspaceId, skuId, { limit = 12 } = {}) {
  return db
    .prepare(
      `SELECT l.unit_cost AS unitCost, l.quantity_units AS quantityUnits, po.po_number AS poNumber,
              po.id AS poId, po.order_date AS orderDate, po.approved_at AS approvedAt,
              s.id AS supplierId, s.name AS supplierName, po.currency
         FROM purchase_order_lines l
         JOIN purchase_orders po ON po.id = l.purchase_order_id
         JOIN suppliers s ON s.id = po.supplier_id
        WHERE l.workspace_id = ? AND l.sku_id = ? AND l.unit_cost IS NOT NULL
          AND po.status NOT IN ('DRAFT', 'AWAITING_APPROVAL', 'CANCELLED')
        ORDER BY COALESCE(po.approved_at, po.created_at) DESC, po.rowid DESC
        LIMIT ?`
    )
    .all(workspaceId, skuId, limit);
}

/** The most recent price change for a product, when there is a previous one. */
function lastPriceChange(db, workspaceId, skuId) {
  const history = costHistory(db, workspaceId, skuId, { limit: 2 });
  if (history.length < 2) return null;
  const [current, previous] = history;
  if (previous.unitCost === 0 || current.unitCost === previous.unitCost) return null;
  return {
    skuId,
    current,
    previous,
    delta: Math.round((current.unitCost - previous.unitCost) * 10000) / 10000,
    percent: Math.round(((current.unitCost - previous.unitCost) / previous.unitCost) * 1000) / 10,
    sameSupplier: current.supplierId === previous.supplierId,
  };
}

module.exports = {
  STATUS,
  EDITABLE,
  OPEN,
  CANCELLABLE,
  stableStringify,
  computeIntegrityHash,
  hydrate,
  hydrateLine,
  get,
  find,
  findByNumber,
  list,
  nextNumber,
  recordEvent,
  eventsFor,
  createOrder,
  defaultDestination,
  destinationForSku,
  submitForApproval,
  approve,
  cancel,
  deleteDraft,
  costHistory,
  lastPriceChange,
};
