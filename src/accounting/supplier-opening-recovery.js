'use strict';

/**
 * Uses a supplier cost the owner enters during first-time setup as evidence for
 * untouched opening inventory.
 *
 * This is intentionally narrow. A current catalogue cost is not historical
 * proof for arbitrary old stock, so a position qualifies only when its entire
 * movement history is one positive physical count labelled "Opening
 * inventory" and nothing has left or arrived since. In that exact lifecycle,
 * the owner has just supplied the missing "what I last paid" fact and Foundry
 * can finish the accounting record without asking them to type it twice.
 */

const crypto = require('crypto');
const { inTransaction } = require('../db');
const { nowIso } = require('../lib/util');
const ledger = require('./ledger');

function recover(db, ctx, input = {}) {
  const skuIds = [...new Set((input.skuIds || []).filter(Boolean))];
  const skuFilter = skuIds.length ? ` AND b.sku_id IN (${skuIds.map(() => '?').join(',')})` : '';
  const candidates = db.prepare(`SELECT b.sku_id, b.location_id, b.on_hand,
      (SELECT si.last_unit_cost FROM supplier_items si
        WHERE si.workspace_id = b.workspace_id AND si.sku_id = b.sku_id
          AND si.is_active = 1 AND si.last_unit_cost IS NOT NULL
        ORDER BY si.is_preferred DESC, si.last_cost_at DESC, si.updated_at DESC LIMIT 1) AS unit_cost
    FROM balances b
    WHERE b.workspace_id = ?${skuFilter} AND b.on_hand > 0
      AND NOT EXISTS (SELECT 1 FROM accounting_inventory_cost_balances cb
        WHERE cb.workspace_id = b.workspace_id AND cb.sku_id = b.sku_id
          AND cb.location_id = b.location_id)`)
    .all(ctx.workspaceId, ...skuIds);

  const positions = [];
  for (const row of candidates) {
    if (row.unit_cost === null || row.unit_cost === undefined) continue;
    const movements = db.prepare(`SELECT id, operation, quantity_delta, reason_code, notes, occurred_at
      FROM movements WHERE workspace_id = ? AND sku_id = ? AND location_id = ?
      ORDER BY occurred_at, seq`).all(ctx.workspaceId, row.sku_id, row.location_id);
    const opening = movements.length === 1 ? movements[0] : null;
    if (!opening || opening.operation !== 'adjust' || Number(opening.quantity_delta) !== Number(row.on_hand)
      || opening.reason_code !== 'physical_count' || opening.notes !== 'Opening inventory') continue;
    const unitCostMinor = Math.round(Number(row.unit_cost) * 100);
    if (!Number.isSafeInteger(unitCostMinor) || unitCostMinor < 0) continue;
    positions.push({ skuId: row.sku_id, locationId: row.location_id,
      quantityUnits: Number(row.on_hand), unitCostMinor,
      totalCostMinor: Number(row.on_hand) * unitCostMinor,
      openingMovementId: opening.id, openingOccurredAt: opening.occurred_at });
  }

  if (!positions.length) return { recoveredUnits: 0, recoveredCostMinor: 0, positions: [] };
  const configured = ledger.settings(db, ctx.workspaceId);
  if (!configured.enabled || !configured.startDate) {
    return { recoveredUnits: 0, recoveredCostMinor: 0, positions: [] };
  }
  const total = positions.reduce((sum, row) => sum + row.totalCostMinor, 0);
  const units = positions.reduce((sum, row) => sum + row.quantityUnits, 0);
  const signature = crypto.createHash('sha256').update(positions.map((row) =>
    `${row.skuId}:${row.locationId}:${row.quantityUnits}:${row.unitCostMinor}:${row.openingMovementId}`
  ).sort().join('|')).digest('hex').slice(0, 24);

  return inTransaction(db, () => {
    const posted = ledger.post(db, ctx, {
      postingDate: configured.startDate,
      description: 'Opening inventory cost from supplier terms entered during setup',
      sourceType: 'verified_opening_cost',
      sourceRecordType: 'supplier_item_cost',
      sourceRecordId: signature,
      sourceKey: `supplier-opening-cost:${signature}`,
      createdByType: 'SYSTEM',
      approvedByUserId: ctx.actorId,
      metadata: {
        method: 'owner-provided last paid cost applied to untouched opening inventory',
        positions,
      },
      lines: [
        ...positions.map((row) => ({ accountKey: 'INVENTORY_ASSET', debitMinor: row.totalCostMinor,
          skuId: row.skuId, locationId: row.locationId,
          memo: `${row.quantityUnits} opening units at the supplier cost entered during setup` })),
        { accountKey: 'OPENING_BALANCE_EQUITY', creditMinor: total,
          memo: 'Cost of inventory already owned when Foundry setup was completed' },
      ],
    });
    const now = nowIso();
    const insert = db.prepare(`INSERT OR IGNORE INTO accounting_inventory_cost_balances
      (workspace_id, sku_id, location_id, quantity_units, total_cost_minor, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const row of positions) insert.run(ctx.workspaceId, row.skuId, row.locationId,
      row.quantityUnits, row.totalCostMinor, now);
    return { recoveredUnits: units, recoveredCostMinor: total, positions,
      journalEntryId: posted.entry.id, replayed: posted.replayed };
  });
}

module.exports = { recover };
