'use strict';

const { inTransaction } = require('../db');
const { ValidationError, NotFoundError, InvariantError } = require('../domain/errors');
const { newId, nowIso } = require('../lib/util');

function state(db, workspaceId, skuId, locationId) {
  const row = db.prepare(`SELECT * FROM accounting_inventory_cost_balances
    WHERE workspace_id = ? AND sku_id = ? AND location_id = ?`).get(workspaceId, skuId, locationId);
  return row || { workspace_id: workspaceId, sku_id: skuId, location_id: locationId,
    quantity_units: 0, total_cost_minor: 0, updated_at: null };
}

function allStates(db, workspaceId) {
  return db.prepare(`SELECT b.*, s.code, s.variant_label, i.name AS item_name, l.name AS location_name
    FROM accounting_inventory_cost_balances b
    JOIN skus s ON s.id = b.sku_id JOIN items i ON i.id = s.item_id
    JOIN locations l ON l.id = b.location_id
    WHERE b.workspace_id = ? ORDER BY i.name, s.code, l.name`).all(workspaceId);
}

function movement(db, workspaceId, movementId) {
  const row = db.prepare('SELECT * FROM movements WHERE id = ? AND workspace_id = ?')
    .get(movementId, workspaceId);
  if (!row) throw new NotFoundError('The inventory movement used for costing could not be found.');
  return row;
}

function movementsForIds(db, workspaceId, movementIds) {
  const ids = [...new Set((movementIds || []).filter(Boolean))];
  if (!ids.length) throw new ValidationError('Costing requires at least one inventory movement.');
  return ids.map((id) => movement(db, workspaceId, id));
}

function alreadyCosted(db, workspaceId, movementId) {
  return db.prepare(`SELECT * FROM accounting_inventory_cost_movements
    WHERE workspace_id = ? AND inventory_movement_id = ?`).get(workspaceId, movementId);
}

function saveState(db, workspaceId, skuId, locationId, quantity, totalCost, now) {
  if (!Number.isSafeInteger(quantity) || quantity < 0 || !Number.isSafeInteger(totalCost) || totalCost < 0) {
    throw new InvariantError('Inventory cost state cannot become negative or fractional.', 'invalid_inventory_cost_state');
  }
  if (quantity === 0) totalCost = 0;
  db.prepare(`INSERT INTO accounting_inventory_cost_balances
    (workspace_id, sku_id, location_id, quantity_units, total_cost_minor, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, sku_id, location_id) DO UPDATE SET
      quantity_units = excluded.quantity_units, total_cost_minor = excluded.total_cost_minor,
      updated_at = excluded.updated_at`)
    .run(workspaceId, skuId, locationId, quantity, totalCost, now);
  return state(db, workspaceId, skuId, locationId);
}

function append(db, movementRow, quantityDelta, costDelta, balance, input) {
  const now = nowIso();
  db.prepare(`INSERT INTO accounting_inventory_cost_movements
    (id, workspace_id, inventory_movement_id, inventory_group_id, sku_id, location_id,
     quantity_delta, cost_delta_minor, unit_cost_minor, balance_quantity_units,
     balance_cost_minor, journal_entry_id, cost_source_type, cost_source_record_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newId('icm'), movementRow.workspace_id, movementRow.id, movementRow.group_id,
      movementRow.sku_id, movementRow.location_id, quantityDelta, costDelta,
      input.unitCostMinor ?? null, balance.quantity_units, balance.total_cost_minor,
      input.journalEntryId || null, input.sourceType, input.sourceRecordId || null, now);
}

/** Adds valued stock. Every physical movement receives its share of the cost. */
function receive(db, ctx, input) {
  const hasExactTotal = input.totalCostMinor !== undefined && input.totalCostMinor !== null;
  const unitCost = Number(input.unitCostMinor);
  const exactTotal = Number(input.totalCostMinor);
  if (hasExactTotal ? (!Number.isSafeInteger(exactTotal) || exactTotal < 0)
    : (!Number.isSafeInteger(unitCost) || unitCost < 0)) {
    throw new ValidationError('Received inventory needs a non-negative unit cost or exact total cost in minor units.');
  }
  return inTransaction(db, () => {
    const rows = movementsForIds(db, ctx.workspaceId, input.movementIds);
    const expected = rows.filter((row) => Number(row.quantity_delta) > 0);
    if (expected.length !== rows.length) throw new ValidationError('A receipt cost can only be attached to incoming inventory movements.');
    const replayed = expected.every((row) => alreadyCosted(db, ctx.workspaceId, row.id));
    if (replayed) return { replayed: true, totalCostMinor: expected.reduce((sum, row) => {
      const prior = alreadyCosted(db, ctx.workspaceId, row.id); return sum + Number(prior.cost_delta_minor);
    }, 0) };
    if (expected.some((row) => alreadyCosted(db, ctx.workspaceId, row.id))) {
      throw new InvariantError('Only part of this inventory receipt has cost history.', 'partial_costing_replay');
    }
    const totalQuantity = expected.reduce((sum, row) => sum + Number(row.quantity_delta), 0);
    let totalCostMinor = 0;
    let allocatedQuantity = 0;
    for (const [index, row] of expected.entries()) {
      const quantity = Number(row.quantity_delta);
      const cost = hasExactTotal
        ? (index === expected.length - 1
          ? exactTotal - totalCostMinor
          : Math.round(exactTotal * (allocatedQuantity + quantity) / totalQuantity) - totalCostMinor)
        : quantity * unitCost;
      const before = state(db, ctx.workspaceId, row.sku_id, row.location_id);
      const after = saveState(db, ctx.workspaceId, row.sku_id, row.location_id,
        Number(before.quantity_units) + quantity, Number(before.total_cost_minor) + cost, nowIso());
      append(db, row, quantity, cost, after, { ...input,
        unitCostMinor: quantity ? Math.round(cost / quantity) : null });
      totalCostMinor += cost;
      allocatedQuantity += quantity;
    }
    return { replayed: false, totalCostMinor };
  });
}

/**
 * Removes stock at deterministic moving weighted-average cost. Integer money
 * is allocated proportionally; the last units consume the exact remainder so
 * repeated rounding can never leave value behind at zero quantity.
 */
function issue(db, ctx, input) {
  return inTransaction(db, () => {
    const rows = movementsForIds(db, ctx.workspaceId, input.movementIds);
    const expected = rows.filter((row) => Number(row.quantity_delta) < 0);
    if (expected.length !== rows.length) throw new ValidationError('An issue cost can only be attached to outgoing inventory movements.');
    const replayed = expected.every((row) => alreadyCosted(db, ctx.workspaceId, row.id));
    if (replayed) return { replayed: true, totalCostMinor: expected.reduce((sum, row) => {
      const prior = alreadyCosted(db, ctx.workspaceId, row.id); return sum + Math.abs(Number(prior.cost_delta_minor));
    }, 0) };
    if (expected.some((row) => alreadyCosted(db, ctx.workspaceId, row.id))) {
      throw new InvariantError('Only part of this inventory issue has cost history.', 'partial_costing_replay');
    }
    let totalCostMinor = 0;
    const allocations = [];
    for (const row of expected) {
      const quantity = Math.abs(Number(row.quantity_delta));
      const before = state(db, ctx.workspaceId, row.sku_id, row.location_id);
      if (Number(before.quantity_units) < quantity) {
        throw new ValidationError('Inventory was issued before its opening or receipt cost was established.');
      }
      const cost = quantity === Number(before.quantity_units)
        ? Number(before.total_cost_minor)
        : Math.round(Number(before.total_cost_minor) * quantity / Number(before.quantity_units));
      const after = saveState(db, ctx.workspaceId, row.sku_id, row.location_id,
        Number(before.quantity_units) - quantity, Number(before.total_cost_minor) - cost, nowIso());
      append(db, row, -quantity, -cost, after, { ...input,
        unitCostMinor: quantity ? Math.round(cost / quantity) : null });
      totalCostMinor += cost;
      allocations.push({ movementId: row.id, skuId: row.sku_id, locationId: row.location_id, quantity, costMinor: cost });
    }
    return { replayed: false, totalCostMinor, allocations };
  });
}

/** Transfers carry cost between locations and create no GL entry. */
function transfer(db, ctx, input) {
  return inTransaction(db, () => {
    const rows = movementsForIds(db, ctx.workspaceId, input.movementIds);
    const outs = rows.filter((row) => row.operation === 'transfer' && row.leg === 'out');
    const ins = rows.filter((row) => row.operation === 'transfer' && row.leg === 'in');
    if (!outs.length || outs.length !== ins.length) throw new ValidationError('A cost transfer needs matching physical out and in movements.');
    if (rows.every((row) => alreadyCosted(db, ctx.workspaceId, row.id))) return { replayed: true };
    if (rows.some((row) => alreadyCosted(db, ctx.workspaceId, row.id))) {
      throw new InvariantError('Only part of this transfer has cost history.', 'partial_costing_replay');
    }
    let totalCostMinor = 0;
    for (const out of outs) {
      const incoming = ins.find((row) => row.sku_id === out.sku_id
        && row.location_id === out.counterparty_location_id
        && Math.abs(Number(row.quantity_delta)) === Math.abs(Number(out.quantity_delta)));
      if (!incoming) throw new ValidationError('The physical transfer legs do not match.');
      const quantity = Math.abs(Number(out.quantity_delta));
      const source = state(db, ctx.workspaceId, out.sku_id, out.location_id);
      if (Number(source.quantity_units) < quantity) throw new ValidationError('Transferred stock has no established source cost.');
      const cost = quantity === Number(source.quantity_units) ? Number(source.total_cost_minor)
        : Math.round(Number(source.total_cost_minor) * quantity / Number(source.quantity_units));
      const sourceAfter = saveState(db, ctx.workspaceId, out.sku_id, out.location_id,
        Number(source.quantity_units) - quantity, Number(source.total_cost_minor) - cost, nowIso());
      append(db, out, -quantity, -cost, sourceAfter, { ...input, unitCostMinor: Math.round(cost / quantity) });
      const destination = state(db, ctx.workspaceId, incoming.sku_id, incoming.location_id);
      const destinationAfter = saveState(db, ctx.workspaceId, incoming.sku_id, incoming.location_id,
        Number(destination.quantity_units) + quantity, Number(destination.total_cost_minor) + cost, nowIso());
      append(db, incoming, quantity, cost, destinationAfter, { ...input, unitCostMinor: Math.round(cost / quantity) });
      totalCostMinor += cost;
    }
    return { replayed: false, totalCostMinor };
  });
}

function valuation(db, workspaceId) {
  const rows = allStates(db, workspaceId);
  const totalCostMinor = rows.reduce((sum, row) => sum + Number(row.total_cost_minor), 0);
  const totalUnits = rows.reduce((sum, row) => sum + Number(row.quantity_units), 0);
  return { rows: rows.map((row) => ({ ...row,
    averageUnitCostMinor: row.quantity_units ? Number(row.total_cost_minor) / Number(row.quantity_units) : 0 })),
  totalUnits, totalCostMinor };
}

/** Changes evidenced inventory value without claiming that quantity moved. */
function adjustValue(db, ctx, input) {
  if (!Array.isArray(input.adjustments) || !input.adjustments.length) {
    throw new ValidationError('An inventory value adjustment needs at least one costed position.');
  }
  if (!input.sourceType || !input.sourceRecordId) {
    throw new ValidationError('An inventory value adjustment needs traceable source evidence.');
  }
  return inTransaction(db, () => {
    const now = nowIso(); let totalDeltaMinor = 0;
    for (const adjustment of input.adjustments) {
      const delta = Number(adjustment.amountDeltaMinor);
      if (!Number.isSafeInteger(delta) || delta === 0) throw new ValidationError('Inventory value changes must use non-zero whole minor currency units.');
      const prior = db.prepare(`SELECT * FROM accounting_inventory_value_adjustments
        WHERE workspace_id = ? AND source_type = ? AND source_record_id = ?
          AND sku_id = ? AND location_id = ?`).get(ctx.workspaceId, input.sourceType,
        input.sourceRecordId, adjustment.skuId, adjustment.locationId);
      if (prior) { totalDeltaMinor += Number(prior.amount_delta_minor); continue; }
      const before = state(db, ctx.workspaceId, adjustment.skuId, adjustment.locationId);
      const afterCost = Number(before.total_cost_minor) + delta;
      if (afterCost < 0) throw new ValidationError('A supplier credit cannot reduce inventory below zero recorded cost.');
      saveState(db, ctx.workspaceId, adjustment.skuId, adjustment.locationId,
        Number(before.quantity_units), afterCost, now);
      db.prepare(`INSERT INTO accounting_inventory_value_adjustments
        (id, workspace_id, sku_id, location_id, amount_delta_minor, quantity_units,
         source_type, source_record_id, journal_entry_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId('icva'), ctx.workspaceId, adjustment.skuId, adjustment.locationId,
          delta, Number(before.quantity_units), input.sourceType, input.sourceRecordId,
          input.journalEntryId || null, now);
      totalDeltaMinor += delta;
    }
    return { totalDeltaMinor };
  });
}

module.exports = { state, allStates, receive, issue, transfer, valuation, adjustValue };
