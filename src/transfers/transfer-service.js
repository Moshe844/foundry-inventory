'use strict';

const { inTransaction } = require('../db');
const inventory = require('../domain/inventory-engine');
const repo = require('../domain/repository');
const permissions = require('../actions/permissions');
const costing = require('../accounting/costing');
const ledger = require('../accounting/ledger');
const sales = require('../sales/sales-order-service');
const { ValidationError, NotFoundError, InvariantError } = require('../domain/errors');
const { newId, nowIso, requirePositiveInt, trimOrNull } = require('../lib/util');
const graph = require('../provenance/service');

const OPEN = ['REQUESTED','APPROVED','PICKED','SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED'];
const RECEIVABLE = ['SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED'];

function numberFor(db, workspaceId) {
  const used = db.prepare('SELECT transfer_number FROM inventory_transfers WHERE workspace_id = ?').all(workspaceId);
  let max = 0;
  for (const row of used) {
    const match = String(row.transfer_number).match(/^TR-(\d+)$/i);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `TR-${String(max + 1).padStart(4, '0')}`;
}

function parseDetail(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function hydrate(db, transfer) {
  if (!transfer) return null;
  const lines = db.prepare(`SELECT tl.*, s.code, s.variant_label, i.name AS item_name,
      i.tracking_mode, lots.code AS lot_code
    FROM inventory_transfer_lines tl
    JOIN skus s ON s.id = tl.sku_id JOIN items i ON i.id = s.item_id
    LEFT JOIN lots ON lots.id = tl.lot_id
    WHERE tl.transfer_id = ? ORDER BY i.name, s.position, tl.id`).all(transfer.id);
  for (const line of lines) {
    line.in_transit_quantity = Math.max(0, Number(line.shipped_quantity)
      - Number(line.received_quantity) - Number(line.lost_quantity) - Number(line.damaged_quantity));
    line.serials = db.prepare(`SELECT ts.*, su.serial FROM inventory_transfer_serials ts
      JOIN serial_units su ON su.id = ts.serial_unit_id WHERE ts.transfer_line_id = ?
      ORDER BY su.serial`).all(line.id);
    line.pegs = db.prepare(`SELECT p.*, so.order_number, c.name AS customer_name
      FROM inventory_transfer_pegs p
      JOIN sales_order_lines sol ON sol.id = p.sales_order_line_id
      JOIN sales_orders so ON so.id = sol.sales_order_id
      JOIN customers c ON c.id = so.customer_id
      WHERE p.transfer_line_id = ? ORDER BY p.priority_snapshot, so.needed_by, so.created_at`).all(line.id);
  }
  const events = db.prepare(`SELECT e.*, u.name AS actor_name FROM inventory_transfer_events e
    LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.transfer_id = ?
    ORDER BY e.created_at, e.rowid`).all(transfer.id).map((row) => ({ ...row, detail: parseDetail(row.detail) }));
  return { ...transfer, decision_detail: parseDetail(transfer.decision_detail), lines, events,
    totals: lines.reduce((sum, line) => ({ requested: sum.requested + Number(line.requested_quantity),
      approved: sum.approved + Number(line.approved_quantity), picked: sum.picked + Number(line.picked_quantity),
      shipped: sum.shipped + Number(line.shipped_quantity), received: sum.received + Number(line.received_quantity),
      lost: sum.lost + Number(line.lost_quantity), damaged: sum.damaged + Number(line.damaged_quantity),
      inTransit: sum.inTransit + Number(line.in_transit_quantity) }),
    { requested: 0, approved: 0, picked: 0, shipped: 0, received: 0, lost: 0, damaged: 0, inTransit: 0 }) };
}

function get(db, workspaceId, id) {
  const row = db.prepare(`SELECT t.*, src.name AS source_name, dst.name AS destination_name
    FROM inventory_transfers t JOIN locations src ON src.id = t.source_location_id
    JOIN locations dst ON dst.id = t.destination_location_id
    WHERE t.id = ? AND t.workspace_id = ?`).get(id, workspaceId);
  if (!row) throw new NotFoundError('That transfer could not be found.');
  return hydrate(db, row);
}

function list(db, workspaceId, { status = null } = {}) {
  const params = [workspaceId];
  let where = 't.workspace_id = ?';
  if (status) { where += ' AND t.status = ?'; params.push(status); }
  return db.prepare(`SELECT t.*, src.name AS source_name, dst.name AS destination_name,
      COALESCE((SELECT SUM(requested_quantity) FROM inventory_transfer_lines WHERE transfer_id = t.id),0) AS requested_units,
      COALESCE((SELECT SUM(shipped_quantity-received_quantity-lost_quantity-damaged_quantity)
        FROM inventory_transfer_lines WHERE transfer_id = t.id),0) AS in_transit_units
    FROM inventory_transfers t JOIN locations src ON src.id = t.source_location_id
    JOIN locations dst ON dst.id = t.destination_location_id
    WHERE ${where} ORDER BY CASE WHEN t.status IN ('RECEIVED','CANCELLED') THEN 1 ELSE 0 END,
      t.expected_arrival_date, t.created_at DESC`).all(...params);
}

function eventByKey(db, workspaceId, key) {
  return db.prepare('SELECT * FROM inventory_transfer_events WHERE workspace_id = ? AND idempotency_key = ?')
    .get(workspaceId, key);
}

function addEvent(db, ctx, transferId, type, detail, key) {
  const existing = eventByKey(db, ctx.workspaceId, key);
  if (existing) return { ...existing, replayed: true };
  const id = newId('tre');
  db.prepare(`INSERT INTO inventory_transfer_events
    (id, workspace_id, transfer_id, event_type, detail, actor_user_id, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, transferId, type, JSON.stringify(detail || {}), ctx.actorId, key, nowIso());
  graph.record(db, ctx.workspaceId, { type: 'HAS_EVENT',
    from: { type: 'inventory_transfer', id: transferId },
    to: { type: 'inventory_transfer_event', id }, basis: 'EVENT' });
  return { id, replayed: false };
}

function keyFor(input, action, transferId) {
  const value = trimOrNull(input.idempotencyKey);
  if (value) return value;
  if (action === 'receive') throw new ValidationError('A receipt needs a stable idempotency key.');
  return `transfer:${transferId}:${action}`;
}

function sourceAvailable(db, workspaceId, skuId, locationId, { excludeTransferId = null } = {}) {
  const onHand = Number(db.prepare(`SELECT COALESCE(on_hand,0) AS n FROM balances
    WHERE workspace_id = ? AND sku_id = ? AND location_id = ?`).get(workspaceId, skuId, locationId)?.n || 0);
  const committed = Number(db.prepare(`SELECT COALESCE(SUM(soa.quantity),0) AS n
    FROM sales_order_allocations soa JOIN sales_order_lines sol ON sol.id = soa.sales_order_line_id
    JOIN sales_orders so ON so.id = sol.sales_order_id
    WHERE soa.workspace_id = ? AND soa.location_id = ? AND sol.sku_id = ?
      AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')`)
    .get(workspaceId, locationId, skuId).n || 0);
  const reserved = Number(db.prepare(`SELECT COALESCE(SUM(tl.approved_quantity),0) AS n
    FROM inventory_transfer_lines tl JOIN inventory_transfers t ON t.id = tl.transfer_id
    WHERE tl.workspace_id = ? AND t.source_location_id = ? AND tl.sku_id = ?
      AND t.status IN ('APPROVED','PICKED') AND (? IS NULL OR t.id <> ?)`)
    .get(workspaceId, locationId, skuId, excludeTransferId, excludeTransferId).n || 0);
  return { onHand, committed, reserved, available: Math.max(0, onHand - committed - reserved) };
}

function request(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.REQUEST_TRANSFER, 'request an inventory transfer');
  const from = repo.requireLocation(db, ctx.workspaceId, input.fromLocationId, 'source location');
  const to = repo.requireLocation(db, ctx.workspaceId, input.toLocationId, 'destination location');
  if (from.id === to.id) throw new ValidationError('Choose two different locations.');
  if (!from.is_active || !to.is_active) throw new ValidationError('Archived locations cannot be used for transfers.');
  if (!Array.isArray(input.lines) || !input.lines.length) throw new ValidationError('Add at least one product to transfer.');
  return inTransaction(db, () => {
    const now = nowIso(); const id = newId('tr');
    db.prepare(`INSERT INTO inventory_transfers
      (id, workspace_id, transfer_number, source_location_id, destination_location_id, status,
       expected_arrival_date, reason, notes, reference, decision_detail, requested_by_user_id,
       requested_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ctx.workspaceId, numberFor(db, ctx.workspaceId), from.id, to.id,
        trimOrNull(input.expectedArrivalDate), trimOrNull(input.reason), trimOrNull(input.notes),
        trimOrNull(input.reference), JSON.stringify(input.decisionDetail || {}), ctx.actorId, now, now, now);
    for (const supplied of input.lines) {
      const sku = repo.requireSku(db, ctx.workspaceId, supplied.skuId);
      const quantity = requirePositiveInt(supplied.quantity, 'Quantity');
      let lotId = null;
      if (sku.tracking_mode === 'lot') {
        const lot = repo.requireLot(db, ctx.workspaceId, supplied.lotId);
        if (lot.sku_id !== sku.id) throw new ValidationError('That lot belongs to a different product.');
        lotId = lot.id;
      }
      const lineId = newId('trl');
      db.prepare(`INSERT INTO inventory_transfer_lines
        (id, workspace_id, transfer_id, sku_id, lot_id, requested_quantity, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(lineId, ctx.workspaceId, id, sku.id, lotId, quantity, now, now);
      graph.record(db, ctx.workspaceId, { type: 'HAS_PART',
        from: { type: 'inventory_transfer', id },
        to: { type: 'inventory_transfer_line', id: lineId }, basis: 'DIRECT_RECORD' });
      if (sku.tracking_mode === 'serial') {
        const serialIds = [...new Set(supplied.serialUnitIds || [])];
        if (serialIds.length !== quantity) throw new ValidationError('Select each serial unit included in this transfer.');
        for (const serialId of serialIds) {
          const unit = db.prepare(`SELECT id FROM serial_units WHERE id = ? AND workspace_id = ?
            AND sku_id = ? AND location_id = ? AND status = 'in_stock'`).get(serialId, ctx.workspaceId, sku.id, from.id);
          if (!unit) throw new ValidationError('One selected serial unit is not available at the source.');
          db.prepare(`INSERT INTO inventory_transfer_serials
            (workspace_id, transfer_line_id, serial_unit_id, state, created_at, updated_at)
            VALUES (?, ?, ?, 'REQUESTED', ?, ?)`).run(ctx.workspaceId, lineId, serialId, now, now);
        }
      }
      const pegs = Array.isArray(supplied.pegs) && supplied.pegs.length
        ? supplied.pegs
        : demandPegs(db, ctx.workspaceId, sku.id, to.id, quantity);
      for (const peg of pegs) addPeg(db, ctx.workspaceId, lineId, peg);
    }
    addEvent(db, ctx, id, 'REQUESTED', { from: from.id, to: to.id }, keyFor(input, 'request', id));
    return get(db, ctx.workspaceId, id);
  });
}

function demandPegs(db, workspaceId, skuId, destinationLocationId, quantity) {
  let remaining = quantity;
  const rows = db.prepare(`SELECT sol.id,
      MAX(0, sol.quantity_ordered - sol.quantity_fulfilled -
        COALESCE((SELECT SUM(a.quantity) FROM sales_order_allocations a
          WHERE a.sales_order_line_id = sol.id),0)) AS waiting
    FROM sales_order_lines sol JOIN sales_orders so ON so.id = sol.sales_order_id
    WHERE sol.workspace_id = ? AND sol.sku_id = ? AND so.fulfillment_location_id = ?
      AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
    ORDER BY so.allocation_priority, so.needed_by IS NULL, so.needed_by, so.created_at, so.id`)
    .all(workspaceId, skuId, destinationLocationId);
  const pegs = [];
  for (const row of rows) {
    if (remaining <= 0) break;
    const allocated = Math.min(remaining, Number(row.waiting || 0));
    if (allocated > 0) pegs.push({ salesOrderLineId: row.id, quantity: allocated,
      reason: 'Destination customer shortage' });
    remaining -= allocated;
  }
  return pegs;
}

function addPeg(db, workspaceId, transferLineId, input) {
  const quantity = requirePositiveInt(input.quantity, 'Peg quantity');
  const line = db.prepare(`SELECT sol.id, sol.sku_id, so.allocation_priority
    FROM sales_order_lines sol JOIN sales_orders so ON so.id = sol.sales_order_id
    WHERE sol.id = ? AND sol.workspace_id = ? AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')`)
    .get(input.salesOrderLineId, workspaceId);
  const transferLine = db.prepare('SELECT sku_id FROM inventory_transfer_lines WHERE id = ? AND workspace_id = ?')
    .get(transferLineId, workspaceId);
  if (!line || !transferLine || line.sku_id !== transferLine.sku_id) throw new ValidationError('A demand peg must name an open order line for the same product.');
  db.prepare(`INSERT INTO inventory_transfer_pegs
    (id, workspace_id, transfer_line_id, sales_order_line_id, quantity, priority_snapshot, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newId('trp'), workspaceId, transferLineId, line.id, quantity,
      Number(line.allocation_priority), trimOrNull(input.reason) || 'Customer demand', nowIso());
  graph.record(db, workspaceId, { type: 'SUPPLIES_DEMAND',
    from: { type: 'inventory_transfer_line', id: transferLineId },
    to: { type: 'sales_order_line', id: line.id }, basis: 'DIRECT_RECORD',
    metadata: { quantity, priority: Number(line.allocation_priority) } });
}

function approve(db, ctx, membership, transferId, input = {}) {
  permissions.assertCan(membership, permissions.APPROVE_TRANSFER, 'approve an inventory transfer');
  return inTransaction(db, () => {
    const before = get(db, ctx.workspaceId, transferId); const key = keyFor(input, 'approve', transferId);
    if (eventByKey(db, ctx.workspaceId, key)) return get(db, ctx.workspaceId, transferId);
    if (before.status !== 'REQUESTED') throw new ValidationError('Only a requested transfer can be approved.');
    for (const line of before.lines) {
      const quantity = input.quantities?.[line.id] === undefined ? Number(line.requested_quantity)
        : requirePositiveInt(input.quantities[line.id], 'Approved quantity');
      if (quantity > Number(line.requested_quantity)) throw new ValidationError('Approved quantity cannot exceed requested quantity.');
      const available = sourceAvailable(db, ctx.workspaceId, line.sku_id, before.source_location_id, { excludeTransferId: before.id });
      if (quantity > available.available) throw new ValidationError(`${line.item_name} only has ${available.available} available at ${before.source_name} after customer commitments and other approved transfers.`);
      db.prepare(`UPDATE inventory_transfer_lines SET approved_quantity = ?, cancelled_quantity = requested_quantity - ?, updated_at = ? WHERE id = ?`)
        .run(quantity, quantity, nowIso(), line.id);
    }
    const now = nowIso();
    db.prepare(`UPDATE inventory_transfers SET status = 'APPROVED', approved_by_user_id = ?, approved_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND workspace_id = ?`)
      .run(ctx.actorId, now, now, transferId, ctx.workspaceId);
    addEvent(db, ctx, transferId, 'APPROVED', {}, key);
    return get(db, ctx.workspaceId, transferId);
  });
}

function pick(db, ctx, membership, transferId, input = {}) {
  permissions.assertCan(membership, permissions.PICK_TRANSFER, 'pick an inventory transfer');
  return inTransaction(db, () => {
    const before = get(db, ctx.workspaceId, transferId); const key = keyFor(input, 'pick', transferId);
    if (eventByKey(db, ctx.workspaceId, key)) return before;
    if (before.status !== 'APPROVED') throw new ValidationError('Only an approved transfer can be picked.');
    for (const line of before.lines) db.prepare(`UPDATE inventory_transfer_lines SET picked_quantity = approved_quantity, updated_at = ? WHERE id = ?`).run(nowIso(), line.id);
    db.prepare(`UPDATE inventory_transfer_serials SET state = 'PICKED', updated_at = ? WHERE transfer_line_id IN
      (SELECT id FROM inventory_transfer_lines WHERE transfer_id = ?)`).run(nowIso(), transferId);
    const now = nowIso();
    db.prepare(`UPDATE inventory_transfers SET status = 'PICKED', picked_by_user_id = ?, picked_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND workspace_id = ?`)
      .run(ctx.actorId, now, now, transferId, ctx.workspaceId);
    addEvent(db, ctx, transferId, 'PICKED', {}, key);
    return get(db, ctx.workspaceId, transferId);
  });
}

function dispatch(db, ctx, membership, transferId, input = {}) {
  permissions.assertCan(membership, permissions.DISPATCH_TRANSFER, 'dispatch an inventory transfer');
  const touchedSkus = [];
  const result = inTransaction(db, () => {
    const before = get(db, ctx.workspaceId, transferId); const key = keyFor(input, 'dispatch', transferId);
    if (eventByKey(db, ctx.workspaceId, key)) return before;
    if (before.status !== 'PICKED') throw new ValidationError('Only a picked transfer can be dispatched.');
    const event = addEvent(db, ctx, transferId, 'SHIPPED', {}, key);
    for (const line of before.lines) {
      const serialIds = line.serials.map((row) => row.serial_unit_id);
      const moved = inventory.dispatchTransfer(db, ctx, { groupId: `transfer:${transferId}:${line.id}`,
        skuId: line.sku_id, fromLocationId: before.source_location_id,
        toLocationId: before.destination_location_id, quantity: line.picked_quantity,
        lotId: line.lot_id, serialUnitIds: serialIds, reference: before.transfer_number,
        notes: `Dispatched ${before.transfer_number}` });
      let dispatchedCost = 0; let costStatus = 'NOT_RECORDED';
      const state = costing.state(db, ctx.workspaceId, line.sku_id, before.source_location_id);
      if (Number(state.quantity_units) >= Number(line.picked_quantity)) {
        const costed = costing.issue(db, ctx, { movementIds: moved.movementIds,
          sourceType: 'inventory_transfer_dispatch', sourceRecordId: line.id });
        dispatchedCost = Number(costed.totalCostMinor || 0); costStatus = 'RECORDED';
      }
      db.prepare(`UPDATE inventory_transfer_lines SET shipped_quantity = ?, dispatched_cost_minor = ?, cost_status = ?, updated_at = ? WHERE id = ?`)
        .run(line.picked_quantity, dispatchedCost, costStatus, nowIso(), line.id);
      db.prepare(`UPDATE inventory_transfer_serials SET state = 'IN_TRANSIT', updated_at = ? WHERE transfer_line_id = ?`).run(nowIso(), line.id);
      for (const movementId of moved.movementIds) db.prepare(`INSERT INTO inventory_transfer_movement_links
        (workspace_id, transfer_line_id, movement_id, role, event_id, created_at) VALUES (?, ?, ?, 'DISPATCH', ?, ?)`)
        .run(ctx.workspaceId, line.id, movementId, event.id, nowIso());
      for (const movementId of moved.movementIds) graph.record(db, ctx.workspaceId, {
        type: 'CAUSED_MOVEMENT', from: { type: 'inventory_transfer_event', id: event.id },
        to: { type: 'inventory_movement', id: movementId }, basis: 'EVENT' });
      postTransitJournal(db, ctx, before, line, event.id, dispatchedCost, 'dispatch');
      touchedSkus.push(line.sku_id);
    }
    const now = nowIso();
    db.prepare(`UPDATE inventory_transfers SET status = 'SHIPPED', dispatched_by_user_id = ?, shipped_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND workspace_id = ?`)
      .run(ctx.actorId, now, now, transferId, ctx.workspaceId);
    return get(db, ctx.workspaceId, transferId);
  });
  if (touchedSkus.length) {
    try { require('../attention/reevaluate').afterMovement(db, ctx.workspaceId, touchedSkus, 'transfer:dispatch'); }
    catch { /* the custody change remains valid even if a follow-up sweep fails */ }
  }
  return result;
}

function markInTransit(db, ctx, membership, transferId, input = {}) {
  permissions.assertCan(membership, permissions.DISPATCH_TRANSFER, 'mark an inventory transfer in transit');
  return inTransaction(db, () => {
    const before = get(db, ctx.workspaceId, transferId); const key = keyFor(input, 'in-transit', transferId);
    if (eventByKey(db, ctx.workspaceId, key)) return before;
    if (!['SHIPPED','IN_TRANSIT'].includes(before.status)) throw new ValidationError('Only a shipped transfer can be marked in transit.');
    if (before.status === 'IN_TRANSIT') return before;
    const now = nowIso();
    db.prepare(`UPDATE inventory_transfers SET status = 'IN_TRANSIT', in_transit_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND workspace_id = ?`)
      .run(now, now, transferId, ctx.workspaceId);
    addEvent(db, ctx, transferId, 'IN_TRANSIT', {}, key);
    return get(db, ctx.workspaceId, transferId);
  });
}

function receive(db, ctx, membership, transferId, input = {}) {
  permissions.assertCan(membership, permissions.RECEIVE_TRANSFER, 'receive an inventory transfer');
  const key = keyFor(input, 'receive', transferId);
  const touchedSkus = [];
  const result = inTransaction(db, () => {
    if (eventByKey(db, ctx.workspaceId, key)) return get(db, ctx.workspaceId, transferId);
    const before = get(db, ctx.workspaceId, transferId);
    if (!RECEIVABLE.includes(before.status)) throw new ValidationError('This transfer is not waiting to be received.');
    if (!Array.isArray(input.lines) || !input.lines.length) throw new ValidationError('Record what arrived, was lost, or was damaged.');
    if (input.lines.some((line) => Number(line.lost || 0) > 0 || Number(line.damaged || 0) > 0)) {
      permissions.assertCan(membership, permissions.ADJUST, 'record transfer loss or damage');
    }
    const event = addEvent(db, ctx, transferId, 'RECEIPT_RECORDED', { lines: input.lines }, key);
    for (const supplied of input.lines) {
      const line = before.lines.find((candidate) => candidate.id === supplied.lineId);
      if (!line) throw new ValidationError('One receipt line is not part of this transfer.');
      const good = Number(supplied.received || 0); const lost = Number(supplied.lost || 0); const damaged = Number(supplied.damaged || 0);
      if (![good,lost,damaged].every(Number.isSafeInteger) || [good,lost,damaged].some((n) => n < 0) || good + lost + damaged <= 0) {
        throw new ValidationError('Received, lost and damaged quantities must be non-negative whole units with at least one unit recorded.');
      }
      const unsettled = Number(line.in_transit_quantity);
      if (good + lost + damaged > unsettled) throw new ValidationError(`That would over-receive ${line.item_name}. Only ${unsettled} remain in transit.`);
      let serialGood = [], serialLost = [], serialDamaged = [];
      if (line.tracking_mode === 'serial') {
        serialGood = [...new Set(supplied.receivedSerialUnitIds || [])];
        serialLost = [...new Set(supplied.lostSerialUnitIds || [])];
        serialDamaged = [...new Set(supplied.damagedSerialUnitIds || [])];
        const all = [...serialGood, ...serialLost, ...serialDamaged];
        if (new Set(all).size !== all.length || serialGood.length !== good || serialLost.length !== lost || serialDamaged.length !== damaged) {
          throw new ValidationError('Name each serialized unit exactly once in the outcome where it belongs.');
        }
        const valid = new Set(line.serials.filter((row) => row.state === 'IN_TRANSIT').map((row) => row.serial_unit_id));
        if (all.some((id) => !valid.has(id))) throw new ValidationError('One serialized unit is not in this transfer custody.');
      }
      let receiptMovementIds = [];
      if (good > 0) {
        const moved = inventory.receiveTransfer(db, ctx, { groupId: `transfer:${transferId}:${line.id}`,
          skuId: line.sku_id, fromLocationId: before.source_location_id,
          toLocationId: before.destination_location_id, quantity: good, lotId: line.lot_id,
          serialUnitIds: serialGood, reference: before.transfer_number,
          notes: `Received ${before.transfer_number}` });
        receiptMovementIds = moved.movementIds;
        const settledBefore = Number(line.received_quantity) + Number(line.lost_quantity) + Number(line.damaged_quantity);
        const costThroughGood = line.cost_status === 'RECORDED'
          ? Math.round(Number(line.dispatched_cost_minor) * (settledBefore + good) / Number(line.shipped_quantity))
            - Math.round(Number(line.dispatched_cost_minor) * settledBefore / Number(line.shipped_quantity)) : 0;
        if (line.cost_status === 'RECORDED') costing.receive(db, ctx, { movementIds: moved.movementIds,
          totalCostMinor: costThroughGood, sourceType: 'inventory_transfer_receipt', sourceRecordId: line.id });
        db.prepare(`UPDATE inventory_transfer_lines SET received_quantity = received_quantity + ?, received_cost_minor = received_cost_minor + ?, updated_at = ? WHERE id = ?`)
          .run(good, costThroughGood, nowIso(), line.id);
        postTransitJournal(db, ctx, before, line, event.id, costThroughGood, 'receipt');
        touchedSkus.push(line.sku_id);
      }
      if (lost + damaged > 0) {
        const latest = db.prepare('SELECT * FROM inventory_transfer_lines WHERE id = ?').get(line.id);
        const settledBefore = Number(latest.received_quantity) + Number(latest.lost_quantity) + Number(latest.damaged_quantity);
        const cost = latest.cost_status === 'RECORDED'
          ? Math.round(Number(latest.dispatched_cost_minor) * (settledBefore + lost + damaged) / Number(latest.shipped_quantity))
            - Math.round(Number(latest.dispatched_cost_minor) * settledBefore / Number(latest.shipped_quantity)) : 0;
        db.prepare(`UPDATE inventory_transfer_lines SET lost_quantity = lost_quantity + ?, damaged_quantity = damaged_quantity + ?,
          written_off_cost_minor = written_off_cost_minor + ?, updated_at = ? WHERE id = ?`)
          .run(lost, damaged, cost, nowIso(), line.id);
        postTransitJournal(db, ctx, before, line, event.id, cost, 'writeoff');
      }
      for (const [state, ids] of [['RECEIVED',serialGood],['LOST',serialLost],['DAMAGED',serialDamaged]]) {
        for (const id of ids) db.prepare(`UPDATE inventory_transfer_serials SET state = ?, updated_at = ? WHERE transfer_line_id = ? AND serial_unit_id = ?`).run(state, nowIso(), line.id, id);
      }
      for (const movementId of receiptMovementIds) db.prepare(`INSERT INTO inventory_transfer_movement_links
        (workspace_id, transfer_line_id, movement_id, role, event_id, created_at) VALUES (?, ?, ?, 'RECEIPT', ?, ?)`)
        .run(ctx.workspaceId, line.id, movementId, event.id, nowIso());
      for (const movementId of receiptMovementIds) graph.record(db, ctx.workspaceId, {
        type: 'CAUSED_MOVEMENT', from: { type: 'inventory_transfer_event', id: event.id },
        to: { type: 'inventory_movement', id: movementId }, basis: 'EVENT' });
    }
    const remaining = db.prepare(`SELECT COALESCE(SUM(shipped_quantity-received_quantity-lost_quantity-damaged_quantity),0) AS n
      FROM inventory_transfer_lines WHERE transfer_id = ?`).get(transferId).n;
    const now = nowIso(); const status = Number(remaining) === 0 ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
    db.prepare(`UPDATE inventory_transfers SET status = ?, received_by_user_id = ?, received_at = CASE WHEN ? = 'RECEIVED' THEN ? ELSE received_at END,
      updated_at = ?, version = version + 1 WHERE id = ? AND workspace_id = ?`)
      .run(status, ctx.actorId, status, now, now, transferId, ctx.workspaceId);
    if (touchedSkus.length) sales.reconcileForSkus(db, ctx, touchedSkus, { triggerEventId: event.id });
    return get(db, ctx.workspaceId, transferId);
  });
  if (touchedSkus.length) {
    try { require('../attention/reevaluate').afterMovement(db, ctx.workspaceId, touchedSkus, 'transfer:receipt'); }
    catch { /* receipt truth is not rolled back by a failed follow-up sweep */ }
  }
  return result;
}

function cancel(db, ctx, membership, transferId, input = {}) {
  permissions.assertCan(membership, permissions.APPROVE_TRANSFER, 'cancel an inventory transfer');
  return inTransaction(db, () => {
    const before = get(db, ctx.workspaceId, transferId); const key = keyFor(input, 'cancel', transferId);
    if (eventByKey(db, ctx.workspaceId, key)) return before;
    if (!['REQUESTED','APPROVED','PICKED'].includes(before.status)) throw new ValidationError('A dispatched transfer cannot be cancelled; record receipt, loss, or damage to settle its custody.');
    const now = nowIso();
    db.prepare(`UPDATE inventory_transfer_lines SET cancelled_quantity = requested_quantity - shipped_quantity, updated_at = ? WHERE transfer_id = ?`).run(now, transferId);
    db.prepare(`UPDATE inventory_transfer_serials SET state = 'CANCELLED', updated_at = ? WHERE transfer_line_id IN
      (SELECT id FROM inventory_transfer_lines WHERE transfer_id = ?)`).run(now, transferId);
    db.prepare(`UPDATE inventory_transfers SET status = 'CANCELLED', cancelled_by_user_id = ?, cancelled_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND workspace_id = ?`)
      .run(ctx.actorId, now, now, transferId, ctx.workspaceId);
    addEvent(db, ctx, transferId, 'CANCELLED', { reason: trimOrNull(input.reason) }, key);
    return get(db, ctx.workspaceId, transferId);
  });
}

function postTransitJournal(db, ctx, transfer, line, eventId, amount, kind) {
  if (!amount || !ledger.settings(db, ctx.workspaceId).enabled) return null;
  const dispatch = kind === 'dispatch'; const receipt = kind === 'receipt';
  return ledger.post(db, ctx, { postingDate: nowIso().slice(0,10),
    description: `${transfer.transfer_number}: ${kind === 'writeoff' ? 'transfer loss or damage' : kind}`,
    sourceType: `inventory_transfer_${kind}`, sourceRecordType: 'inventory_transfer',
    sourceRecordId: transfer.id, sourceKey: `inventory-transfer:${transfer.id}:${line.id}:${eventId}:${kind}`,
    lines: dispatch ? [
      { accountKey: 'INVENTORY_IN_TRANSIT', debitMinor: amount, skuId: line.sku_id },
      { accountKey: 'INVENTORY_ASSET', creditMinor: amount, skuId: line.sku_id, locationId: transfer.source_location_id },
    ] : receipt ? [
      { accountKey: 'INVENTORY_ASSET', debitMinor: amount, skuId: line.sku_id, locationId: transfer.destination_location_id },
      { accountKey: 'INVENTORY_IN_TRANSIT', creditMinor: amount, skuId: line.sku_id },
    ] : [
      { accountKey: 'INVENTORY_ADJUSTMENTS', debitMinor: amount, skuId: line.sku_id },
      { accountKey: 'INVENTORY_IN_TRANSIT', creditMinor: amount, skuId: line.sku_id },
    ] });
}

function incomingForSku(db, workspaceId, skuId, { locationId = null } = {}) {
  const params = [workspaceId, skuId]; let location = '';
  if (locationId) { location = ' AND t.destination_location_id = ?'; params.push(locationId); }
  return db.prepare(`SELECT t.id AS transferId, t.transfer_number AS transferNumber,
      t.expected_arrival_date AS expectedDate, t.destination_location_id AS destinationLocationId,
      src.name AS sourceName,
      (tl.shipped_quantity-tl.received_quantity-tl.lost_quantity-tl.damaged_quantity) AS units
    FROM inventory_transfer_lines tl JOIN inventory_transfers t ON t.id = tl.transfer_id
    JOIN locations src ON src.id = t.source_location_id
    WHERE tl.workspace_id = ? AND tl.sku_id = ?
      AND t.status IN ('SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED')
      AND (tl.shipped_quantity-tl.received_quantity-tl.lost_quantity-tl.damaged_quantity) > 0${location}
    ORDER BY t.expected_arrival_date, t.created_at`).all(...params);
}

function compareTransferToPurchase(db, workspaceId, input) {
  const need = requirePositiveInt(input.quantity, 'Required quantity');
  const position = sourceAvailable(db, workspaceId, input.skuId, input.fromLocationId);
  const transferDays = Math.max(0, Number(input.transferDays ?? 1));
  const purchaseDays = Math.max(0, Number(input.purchaseDays ?? 14));
  const transferCost = Math.max(0, Number(input.transferCostMinor ?? 0));
  const purchaseCost = Math.max(0, Number(input.purchaseCostMinor ?? 0));
  const risk = String(input.transferRisk || 'normal').toLowerCase();
  let choice; let reason;
  if (position.available < need) {
    choice = 'PURCHASE'; reason = `Only ${position.available} can safely leave the source after commitments; ${need} are needed.`;
  } else if (risk === 'high' && purchaseDays <= transferDays) {
    choice = 'PURCHASE'; reason = 'The transfer is high risk and purchasing is expected no later.';
  } else if (transferDays <= purchaseDays && transferCost <= purchaseCost) {
    choice = 'TRANSFER'; reason = `Transfer is expected in ${transferDays} day${transferDays === 1 ? '' : 's'} and costs no more than purchasing, while ${position.available} are available at the source.`;
  } else if (transferDays < purchaseDays) {
    choice = 'TRANSFER'; reason = `Transfer is expected ${purchaseDays - transferDays} day${purchaseDays - transferDays === 1 ? '' : 's'} sooner; the cost difference is ${Math.max(0, transferCost - purchaseCost)} minor currency units.`;
  } else {
    choice = 'PURCHASE'; reason = `Purchasing is expected no later and saves ${Math.max(0, transferCost - purchaseCost)} minor currency units.`;
  }
  return { choice, reason, evidence: { need, source: position, transferDays, purchaseDays, transferCostMinor: transferCost, purchaseCostMinor: purchaseCost, transferRisk: risk } };
}

function verify(db, workspaceId, transferId) {
  const transfer = get(db, workspaceId, transferId); const problems = [];
  for (const line of transfer.lines) {
    if (line.in_transit_quantity < 0) problems.push(`${line.item_name} has negative transfer custody.`);
    const dispatchMoved = db.prepare(`SELECT COALESCE(SUM(ABS(m.quantity_delta)),0) AS n FROM inventory_transfer_movement_links ml
      JOIN movements m ON m.id = ml.movement_id WHERE ml.transfer_line_id = ? AND ml.role = 'DISPATCH'`).get(line.id).n;
    const receiptMoved = db.prepare(`SELECT COALESCE(SUM(m.quantity_delta),0) AS n FROM inventory_transfer_movement_links ml
      JOIN movements m ON m.id = ml.movement_id WHERE ml.transfer_line_id = ? AND ml.role = 'RECEIPT'`).get(line.id).n;
    if (Number(dispatchMoved) !== Number(line.shipped_quantity)) problems.push(`${line.item_name} dispatch movements do not reconcile.`);
    if (Number(receiptMoved) !== Number(line.received_quantity)) problems.push(`${line.item_name} receipt movements do not reconcile.`);
    if (line.cost_status === 'RECORDED' && Number(line.received_cost_minor) + Number(line.written_off_cost_minor) > Number(line.dispatched_cost_minor)) problems.push(`${line.item_name} transfer cost is over-settled.`);
  }
  if (transfer.status === 'RECEIVED' && transfer.totals.inTransit !== 0) problems.push('A received transfer still has inventory in custody.');
  return { ok: problems.length === 0, problems, transfer };
}

module.exports = { OPEN, request, approve, pick, dispatch, markInTransit, receive, cancel,
  get, list, sourceAvailable, incomingForSku, compareTransferToPurchase, verify };
