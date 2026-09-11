'use strict';

const { newId, nowIso } = require('../lib/util');

/**
 * Converts only provable historical atomic transfers. A group must contain
 * balanced transfer legs for one source/destination pair. Anything ambiguous
 * remains movement history; it is never guessed into a lifecycle document.
 */
function backfillLegacyTransfers(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory_transfers'`).get()) return 0;
  const migrateAll = db.transaction(() => {
    const groups = db.prepare(`SELECT workspace_id, group_id, MIN(occurred_at) AS occurred_at
      FROM movements WHERE operation = 'transfer' GROUP BY workspace_id, group_id
      ORDER BY MIN(seq)`).all();
    let created = 0;
    for (const group of groups) {
    if (db.prepare('SELECT 1 FROM inventory_transfers WHERE workspace_id = ? AND legacy_group_id = ?')
      .get(group.workspace_id, group.group_id)) continue;
    const rows = db.prepare(`SELECT * FROM movements WHERE workspace_id = ? AND group_id = ?
      AND operation = 'transfer' ORDER BY seq`).all(group.workspace_id, group.group_id);
    const outs = rows.filter((row) => row.leg === 'out');
    const ins = rows.filter((row) => row.leg === 'in');
    if (!outs.length || !ins.length) continue;
    const sources = new Set(outs.map((row) => row.location_id));
    const destinations = new Set(ins.map((row) => row.location_id));
    if (sources.size !== 1 || destinations.size !== 1 || [...sources][0] === [...destinations][0]) continue;
    const signature = (row) => `${row.sku_id}|${row.lot_id || ''}`;
    const sum = (set, sign) => set.reduce((map, row) => map.set(signature(row),
      (map.get(signature(row)) || 0) + sign * Number(row.quantity_delta)), new Map());
    const outTotals = sum(outs, -1); const inTotals = sum(ins, 1);
    if (outTotals.size !== inTotals.size || [...outTotals].some(([key, qty]) => inTotals.get(key) !== qty)) continue;
    const actor = rows[0].actor_user_id; const at = group.occurred_at || nowIso();
    const id = newId('tr');
    let n = db.prepare('SELECT COUNT(*) AS n FROM inventory_transfers WHERE workspace_id = ?').get(group.workspace_id).n + 1;
    let transferNumber = `TR-L${String(n).padStart(4, '0')}`;
    while (db.prepare('SELECT 1 FROM inventory_transfers WHERE workspace_id = ? AND transfer_number = ?').get(group.workspace_id, transferNumber)) {
      transferNumber = `TR-L${String(++n).padStart(4, '0')}`;
    }
    db.prepare(`INSERT INTO inventory_transfers
      (id, workspace_id, transfer_number, source_location_id, destination_location_id, status,
       reason, notes, reference, decision_detail, legacy_group_id, requested_by_user_id,
       approved_by_user_id, picked_by_user_id, dispatched_by_user_id, received_by_user_id,
       requested_at, approved_at, picked_at, shipped_at, in_transit_at, received_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, group.workspace_id, transferNumber, [...sources][0], [...destinations][0],
        'RECEIVED', 'Historical completed transfer',
        'Imported from balanced atomic movement legs; intermediate timestamps are unknown.',
        group.group_id, '{}', group.group_id, actor, actor, actor, actor, actor,
        at, at, at, at, at, at, at, at);
    for (const [key, quantity] of outTotals) {
      const [skuId, lotIdText] = key.split('|'); const lineId = newId('trl');
      const lotId = lotIdText || null;
      db.prepare(`INSERT INTO inventory_transfer_lines
        (id, workspace_id, transfer_id, sku_id, lot_id, requested_quantity, approved_quantity,
         picked_quantity, shipped_quantity, received_quantity, cost_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NOT_RECORDED', ?, ?)`)
        .run(lineId, group.workspace_id, id, skuId, lotId, quantity, quantity, quantity, quantity, quantity, at, at);
      for (const row of outs.filter((candidate) => signature(candidate) === key)) {
        if (row.serial_unit_id) db.prepare(`INSERT OR IGNORE INTO inventory_transfer_serials
          (workspace_id, transfer_line_id, serial_unit_id, state, created_at, updated_at)
          VALUES (?, ?, ?, 'RECEIVED', ?, ?)`).run(group.workspace_id, lineId, row.serial_unit_id, at, at);
      }
    }
    db.prepare(`INSERT INTO inventory_transfer_events
      (id, workspace_id, transfer_id, event_type, detail, actor_user_id, idempotency_key, created_at)
      VALUES (?, ?, ?, 'LEGACY_COMPLETED', ?, ?, ?, ?)`)
      .run(newId('tre'), group.workspace_id, id,
        JSON.stringify({ movementGroupId: group.group_id, intermediateStateKnown: false }), actor,
        `legacy-transfer:${group.group_id}`, at);
      created += 1;
    }
    return created;
  });

  // Database startup is concurrent in production workers. Taking the write
  // lease before the initial existence check makes the check-and-create one
  // operation across processes, so a second starter observes the first one's
  // completed legacy document instead of racing its unique key.
  return migrateAll.immediate();
}

module.exports = { backfillLegacyTransfers };
