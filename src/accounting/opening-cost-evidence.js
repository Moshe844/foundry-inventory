'use strict';

/**
 * Reconstructs inventory cost at the accounting start date from immutable,
 * pre-start purchase receipts. This is deliberately conservative: an
 * adjustment, transfer, or receipt without an approved PO cost makes the
 * position unknown instead of turning a current supplier price into history.
 */

const crypto = require('crypto');
const { inTransaction } = require('../db');
const { nowIso } = require('../lib/util');
const ledger = require('./ledger');

function parse(value, fallback = []) {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}

function targetRows(db, workspaceId, targets) {
  if (Array.isArray(targets) && targets.length) {
    const seen = new Set();
    return targets.filter((row) => {
      const key = `${row.skuId}:${row.locationId}`;
      if (!row.skuId || !row.locationId || seen.has(key)) return false;
      seen.add(key); return true;
    }).map((row) => ({ sku_id: row.skuId, location_id: row.locationId }));
  }
  return db.prepare(`SELECT DISTINCT b.sku_id, b.location_id
    FROM balances b JOIN skus s ON s.id = b.sku_id JOIN items i ON i.id = s.item_id
    WHERE b.workspace_id = ? AND b.on_hand > 0 AND s.is_active = 1 AND i.is_active = 1`)
    .all(workspaceId);
}

function receiptCostMap(db, workspaceId, boundary, skuIds = null) {
  const map = new Map();
  const skuClause = Array.isArray(skuIds) && skuIds.length
    ? ` AND prl.sku_id IN (${skuIds.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`SELECT prl.movement_ids, prl.quantity_units, prl.sku_id, prl.location_id, pol.unit_cost,
      po.id AS purchase_order_id, po.po_number, por.id AS receipt_id, por.received_at
    FROM purchase_order_receipt_lines prl
    JOIN purchase_order_receipts por ON por.id = prl.receipt_id
    JOIN purchase_order_lines pol ON pol.id = prl.purchase_order_line_id
    JOIN purchase_orders po ON po.id = por.purchase_order_id
    WHERE prl.workspace_id = ? AND por.received_at < ?${skuClause}`)
    .all(workspaceId, boundary, ...(skuIds || []));
  for (const row of rows) {
    if (row.unit_cost === null || row.unit_cost === undefined) continue;
    const unitCostMinor = Math.round(Number(row.unit_cost) * 100);
    if (!Number.isSafeInteger(unitCostMinor) || unitCostMinor < 0) continue;
    for (const movementId of parse(row.movement_ids)) map.set(movementId, { ...row, unitCostMinor });
  }
  return map;
}

function replayPartialEvidence(db, workspaceId, boundary, targets) {
  const skuIds = [...new Set(targets.map((row) => row.sku_id))];
  if (!skuIds.length) return [];
  const movements = db.prepare(`SELECT * FROM movements
    WHERE workspace_id = ? AND sku_id IN (${skuIds.map(() => '?').join(',')}) AND occurred_at < ?
    ORDER BY occurred_at, seq`).all(workspaceId, ...skuIds, boundary);
  const receipts = receiptCostMap(db, workspaceId, boundary, skuIds);
  const states = new Map();
  const transfers = new Map();
  const stateFor = (skuId, locationId) => {
    const key = `${skuId}:${locationId}`;
    if (!states.has(key)) states.set(key, { physicalUnits: 0, costedUnits: 0,
      totalCostMinor: 0, evidence: [], missingReasons: [] });
    return states.get(key);
  };
  const remove = (state, quantity) => {
    const removed = Math.min(quantity, state.physicalUnits);
    // With mixed supported/unsupported stock, consume supported cost first.
    // This is deliberately conservative: the value left on hand can never be
    // overstated merely because the individual units were interchangeable.
    const costedUnits = Math.min(removed, state.costedUnits);
    const costMinor = costedUnits === state.costedUnits ? state.totalCostMinor
      : Math.round(state.totalCostMinor * costedUnits / state.costedUnits);
    state.physicalUnits -= removed;
    state.costedUnits -= costedUnits;
    state.totalCostMinor -= costMinor;
    return { physicalUnits: removed, costedUnits, costMinor };
  };

  for (const movement of movements) {
    const state = stateFor(movement.sku_id, movement.location_id);
    const delta = Number(movement.quantity_delta);
    if (delta > 0) {
      if (movement.operation === 'transfer' && movement.leg === 'in') {
        const carried = transfers.get(`${movement.group_id}:${movement.sku_id}`);
        state.physicalUnits += delta;
        if (carried) {
          state.costedUnits += carried.costedUnits;
          state.totalCostMinor += carried.costMinor;
          state.evidence.push(...carried.evidence, { movementId: movement.id,
            transferGroupId: movement.group_id, quantityUnits: delta,
            costedUnits: carried.costedUnits, costMinor: carried.costMinor });
        } else {
          state.missingReasons.push(`The ${delta}-unit transfer into this location has no recoverable source cost.`);
        }
        continue;
      }
      const receipt = receipts.get(movement.id);
      state.physicalUnits += delta;
      if (receipt && movement.operation === 'receive') {
        state.costedUnits += delta;
        state.totalCostMinor += delta * receipt.unitCostMinor;
        state.evidence.push({ movementId: movement.id, receiptId: receipt.receipt_id,
          purchaseOrderId: receipt.purchase_order_id, poNumber: receipt.po_number,
          quantityUnits: delta, unitCostMinor: receipt.unitCostMinor,
          receivedAt: receipt.received_at });
      } else {
        state.missingReasons.push(`The ${delta}-unit ${movement.operation} has no approved purchase-receipt cost.`);
      }
      continue;
    }

    const removed = remove(state, Math.abs(delta));
    if (movement.operation === 'transfer' && movement.leg === 'out') {
      transfers.set(`${movement.group_id}:${movement.sku_id}`, { ...removed,
        evidence: state.evidence.slice() });
    }
  }

  return targets.map((target) => {
    const identity = db.prepare(`SELECT s.code, s.variant_label, i.name AS item_name, l.name AS location_name
      FROM skus s JOIN items i ON i.id = s.item_id JOIN locations l ON l.id = ?
      WHERE s.id = ? AND s.workspace_id = ?`).get(target.location_id, target.sku_id, workspaceId);
    if (!identity) return { ...target, known: false, costedUnits: 0, missingUnits: 0,
      reason: 'Inventory position no longer exists.' };
    const state = stateFor(target.sku_id, target.location_id);
    const physicalUnits = Math.max(0, state.physicalUnits);
    const costedUnits = Math.min(physicalUnits, state.costedUnits);
    const missingUnits = Math.max(0, physicalUnits - costedUnits);
    return { ...target, ...identity, known: costedUnits > 0, partial: costedUnits > 0 && missingUnits > 0,
      physicalUnits, quantityUnits: costedUnits, costedUnits, missingUnits,
      totalCostMinor: state.totalCostMinor,
      averageUnitCostMinor: costedUnits ? Math.round(state.totalCostMinor / costedUnits) : null,
      evidence: state.evidence,
      reason: missingUnits ? `${missingUnits} of ${physicalUnits} on-hand units have no approved historical cost evidence.` : null };
  });
}

function infer(db, workspaceId, startDate, targets = null, options = {}) {
  const requestedBoundary = options.boundary || `${startDate}T00:00:00.000Z`;
  const boundary = Number.isNaN(Date.parse(requestedBoundary))
    ? `${startDate}T00:00:00.000Z` : new Date(requestedBoundary).toISOString();
  const rows = replayPartialEvidence(db, workspaceId, boundary,
    targetRows(db, workspaceId, targets));
  return {
    startDate, boundary,
    known: rows.filter((row) => row.known),
    unknown: rows.filter((row) => row.missingUnits > 0 || !row.known),
  };
}

function apply(db, ctx, inference) {
  const eligible = inference.known.filter((row) => !db.prepare(`SELECT 1 FROM accounting_inventory_cost_balances
    WHERE workspace_id = ? AND sku_id = ? AND location_id = ?`)
    .get(ctx.workspaceId, row.sku_id, row.location_id));
  if (!eligible.length) return { applied: [], journalEntryId: null, replayed: true };
  return inTransaction(db, () => {
    const total = eligible.reduce((sum, row) => sum + row.totalCostMinor, 0);
    const signature = crypto.createHash('sha256').update(eligible
      .map((row) => `${row.sku_id}:${row.location_id}:${row.quantityUnits}:${row.totalCostMinor}`)
      .sort().join('|')).digest('hex').slice(0, 24);
    const reconstructedLater = inference.boundary
      && inference.boundary !== `${inference.startDate}T00:00:00.000Z`;
    const posted = ledger.post(db, ctx, {
      postingDate: inference.startDate,
      description: reconstructedLater
        ? 'Recovered inventory cost from verified movement history'
        : 'Opening inventory cost from verified purchase receipts',
      sourceType: reconstructedLater ? 'verified_inventory_cost_recovery' : 'verified_opening_cost',
      sourceRecordType: 'purchase_receipt_evidence',
      sourceRecordId: signature,
      sourceKey: `verified-inventory-cost:${inference.startDate}:${signature}`,
      createdByType: 'SYSTEM',
      metadata: { method: reconstructedLater
        ? 'pre-event weighted-average reconstruction from immutable movements'
        : 'pre-start weighted-average reconstruction',
        evidenceBoundary: inference.boundary || null,
        positions: eligible.map((row) => ({ skuId: row.sku_id, locationId: row.location_id,
          quantityUnits: row.quantityUnits, totalCostMinor: row.totalCostMinor,
          evidence: row.evidence })) },
      lines: [
        ...eligible.map((row) => ({ accountKey: 'INVENTORY_ASSET', debitMinor: row.totalCostMinor,
          skuId: row.sku_id, locationId: row.location_id,
          memo: `${row.quantityUnits} units from verified purchase receipts` })),
        { accountKey: 'OPENING_BALANCE_EQUITY', creditMinor: total,
          memo: reconstructedLater
            ? 'Verified legacy inventory held before this accounting event'
            : 'Verified inventory held when Accounting started' },
      ],
    });
    const now = nowIso();
    const insert = db.prepare(`INSERT INTO accounting_inventory_cost_balances
      (workspace_id, sku_id, location_id, quantity_units, total_cost_minor, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const row of eligible) insert.run(ctx.workspaceId, row.sku_id, row.location_id,
      row.quantityUnits, row.totalCostMinor, now);
    return { applied: eligible, journalEntryId: posted.entry.id, replayed: posted.replayed };
  });
}

module.exports = { infer, apply };
