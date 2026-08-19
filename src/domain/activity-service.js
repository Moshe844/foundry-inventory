'use strict';

const { OPERATION_IDS, ADJUSTMENT_REASONS, ISSUE_REASONS, labelFor } = require('./constants');

/**
 * The activity ledger, read back the way a person would describe it.
 *
 * Movements are stored as legs (a transfer is an out leg and an in leg sharing
 * a group id). This module regroups them so staff see one sentence per action
 * while the underlying audit rows stay atomic.
 */

const MOVEMENT_SELECT = `
  SELECT m.*,
         i.name          AS item_name,
         i.tracking_mode AS tracking_mode,
         s.code          AS sku_code,
         s.variant_label AS variant_label,
         l.name          AS location_name,
         cl.name         AS counterparty_name,
         u.name          AS actor_name,
         lo.code         AS lot_code,
         lo.expires_at   AS lot_expires_at,
         su.serial       AS serial,
         adj.expected_qty AS expected_qty,
         adj.counted_qty  AS counted_qty
    FROM movements m
    JOIN items i      ON i.id = m.item_id
    JOIN skus s       ON s.id = m.sku_id
    JOIN locations l  ON l.id = m.location_id
    LEFT JOIN locations cl ON cl.id = m.counterparty_location_id
    JOIN users u      ON u.id = m.actor_user_id
    LEFT JOIN lots lo ON lo.id = m.lot_id
    LEFT JOIN serial_units su ON su.id = m.serial_unit_id
    LEFT JOIN adjustments adj ON adj.movement_id = m.id
`;

function buildFilters(workspaceId, filters = {}) {
  const where = ['m.workspace_id = @workspaceId'];
  const params = { workspaceId };
  if (filters.itemId) {
    where.push('m.item_id = @itemId');
    params.itemId = filters.itemId;
  }
  if (filters.skuId) {
    where.push('m.sku_id = @skuId');
    params.skuId = filters.skuId;
  }
  if (filters.locationId) {
    where.push('m.location_id = @locationId');
    params.locationId = filters.locationId;
  }
  if (filters.operation && OPERATION_IDS.includes(filters.operation)) {
    where.push('m.operation = @operation');
    params.operation = filters.operation;
  }
  if (filters.actorId) {
    where.push('m.actor_user_id = @actorId');
    params.actorId = filters.actorId;
  }
  if (filters.lotId) {
    where.push('m.lot_id = @lotId');
    params.lotId = filters.lotId;
  }
  if (filters.serialUnitId) {
    where.push('m.serial_unit_id = @serialUnitId');
    params.serialUnitId = filters.serialUnitId;
  }
  if (filters.dateFrom) {
    where.push('m.occurred_at >= @dateFrom');
    params.dateFrom = `${filters.dateFrom}T00:00:00.000Z`;
  }
  if (filters.dateTo) {
    where.push('m.occurred_at <= @dateTo');
    params.dateTo = `${filters.dateTo}T23:59:59.999Z`;
  }
  return { where: where.join(' AND '), params };
}

function listActivity(db, workspaceId, filters = {}) {
  const limit = Math.min(Number(filters.limit) || 25, 200);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const { where, params } = buildFilters(workspaceId, filters);

  const groupRows = db
    .prepare(
      // Ordered by when it happened, not by when it was typed in.
      //
      // The ledger's seq is the immutable order of recording, and sorting on it
      // is right for an audit trail — but this page is labelled "newest first"
      // and prints the date each movement occurred. Stock entered late, with
      // last week's date on it, therefore appeared above movements that really
      // did happen later, and the visible dates ran 17th, 13th, 16th. seq stays
      // as the tie-break so anything recorded on the same instant keeps its
      // recorded order.
      `SELECT m.group_id AS group_id, MAX(m.seq) AS max_seq,
              MAX(m.occurred_at) AS occurred_at
         FROM movements m
        WHERE ${where}
        GROUP BY m.group_id
        ORDER BY occurred_at DESC, max_seq DESC
        LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: limit + 1, offset });

  const hasMore = groupRows.length > limit;
  const groupIds = groupRows.slice(0, limit).map((row) => row.group_id);
  if (groupIds.length === 0) return { groups: [], hasMore: false, offset, limit };

  const placeholders = groupIds.map(() => '?').join(', ');
  const rows = db
    .prepare(`${MOVEMENT_SELECT} WHERE m.workspace_id = ? AND m.group_id IN (${placeholders}) ORDER BY m.seq`)
    .all(workspaceId, ...groupIds);

  const order = new Map(groupIds.map((id, index) => [id, index]));
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.group_id)) grouped.set(row.group_id, []);
    grouped.get(row.group_id).push(row);
  }

  const groups = [...grouped.entries()]
    .sort((a, b) => order.get(a[0]) - order.get(b[0]))
    .map(([groupId, legs]) => summarize(groupId, legs));

  return { groups, hasMore, offset, limit };
}

function countActivity(db, workspaceId, filters = {}) {
  const { where, params } = buildFilters(workspaceId, filters);
  const row = db
    .prepare(`SELECT COUNT(DISTINCT m.group_id) AS total FROM movements m WHERE ${where}`)
    .get(params);
  return row.total;
}

function reasonLabel(operation, code) {
  if (!code) return null;
  return operation === 'adjust' ? labelFor(ADJUSTMENT_REASONS, code) : labelFor(ISSUE_REASONS, code);
}

function summarize(groupId, legs) {
  const first = legs[0];
  const operation = first.operation;
  const positive = legs.filter((l) => l.quantity_delta > 0);
  const negative = legs.filter((l) => l.quantity_delta < 0);
  const serials = [...new Set(legs.map((l) => l.serial).filter(Boolean))];
  const lots = [...new Set(legs.map((l) => l.lot_code).filter(Boolean))];

  const label = first.variant_label ? `${first.item_name} / ${first.variant_label}` : first.item_name;

  const base = {
    groupId,
    operation,
    occurredAt: first.occurred_at,
    actorName: first.actor_name,
    actorId: first.actor_user_id,
    itemId: first.item_id,
    itemName: first.item_name,
    skuId: first.sku_id,
    skuCode: first.sku_code,
    variantLabel: first.variant_label,
    displayName: label,
    trackingMode: first.tracking_mode,
    reasonCode: first.reason_code,
    reasonLabel: reasonLabel(operation, first.reason_code),
    notes: first.notes,
    reference: first.reference,
    serials,
    lots,
    legs,
  };

  if (operation === 'transfer') {
    const out = negative[0];
    const inLeg = positive[0];
    const quantity = positive.reduce((sum, l) => sum + l.quantity_delta, 0);
    return {
      ...base,
      quantity,
      fromLocation: out ? out.location_name : null,
      fromLocationId: out ? out.location_id : null,
      toLocation: inLeg ? inLeg.location_name : null,
      toLocationId: inLeg ? inLeg.location_id : null,
      sentence: buildSentence('transfer', { label, quantity, serials, lots, from: out && out.location_name, to: inLeg && inLeg.location_name }),
      balanceAfter: inLeg ? inLeg.balance_after : null,
    };
  }

  if (operation === 'adjust') {
    const expected = first.expected_qty;
    const counted = first.counted_qty;
    const delta = legs.reduce((sum, l) => sum + l.quantity_delta, 0);
    return {
      ...base,
      quantity: delta,
      expected,
      counted,
      locationName: first.location_name,
      locationId: first.location_id,
      balanceAfter: legs[legs.length - 1].balance_after,
      sentence: buildSentence('adjust', {
        label,
        expected,
        counted: first.tracking_mode === 'serial' ? null : counted,
        delta,
        serials,
        lots,
        location: first.location_name,
      }),
    };
  }

  const quantity = operation === 'receive'
    ? positive.reduce((sum, l) => sum + l.quantity_delta, 0)
    : Math.abs(negative.reduce((sum, l) => sum + l.quantity_delta, 0));

  return {
    ...base,
    quantity,
    locationName: first.location_name,
    locationId: first.location_id,
    balanceAfter: legs[legs.length - 1].balance_after,
    sentence: buildSentence(operation, { label, quantity, serials, lots, location: first.location_name }),
  };
}

function serialPhrase(serials) {
  if (serials.length === 0) return '';
  if (serials.length <= 3) return ` (${serials.join(', ')})`;
  return ` (${serials.slice(0, 3).join(', ')} and ${serials.length - 3} more)`;
}

function lotPhrase(lots) {
  if (lots.length === 0) return '';
  return lots.length === 1 ? ` from lot ${lots[0]}` : ` from lots ${lots.join(', ')}`;
}

function buildSentence(operation, data) {
  const { label, quantity, serials = [], lots = [] } = data;
  switch (operation) {
    case 'receive':
      return `Received ${quantity} × ${label}${serials.length ? serialPhrase(serials) : ''}${
        lots.length ? ` as lot ${lots.join(', ')}` : ''
      } into ${data.location}.`;
    case 'issue':
      return `Issued ${quantity} × ${label}${serialPhrase(serials)}${lotPhrase(lots)} from ${data.location}.`;
    case 'transfer':
      return `Transferred ${quantity} × ${label}${serialPhrase(serials)}${lotPhrase(lots)} from ${data.from} to ${data.to}.`;
    case 'adjust': {
      if (data.counted === null || data.counted === undefined) {
        return `Wrote off ${Math.abs(data.delta)} × ${label}${serialPhrase(serials)} at ${data.location}.`;
      }
      return `Adjusted ${label}${lotPhrase(lots)} at ${data.location} from ${data.expected} to ${data.counted}.`;
    }
    default:
      return `${operation} ${label}`;
  }
}

module.exports = { listActivity, countActivity, summarize, buildSentence };
