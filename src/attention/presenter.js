'use strict';

/**
 * Turns a stored attention item into something a page can render: real names,
 * real links, and the actual movements behind the evidence.
 *
 * Nothing here re-derives a number. If a value is on screen it came from the
 * item's own stored evidence, which came from the ledger.
 */

const SEVERITY = {
  critical: { label: 'Needs attention now', tone: 'danger', order: 0 },
  important: { label: 'Worth doing today', tone: 'warn', order: 1 },
  watch: { label: 'Worth knowing', tone: 'muted', order: 2 },
};

const CATEGORY_LABEL = {
  replenishment_needed: 'Replenishment plan',
  stock_protection_boundary: 'Protected stock limit',
  low_stock: 'Out of stock',
  stockout_risk: 'Running low',
  location_imbalance: 'Stock in the wrong place',
  unusual_adjustment: 'Unusual correction',
  expiring_inventory: 'Approaching expiry',
  stale_inventory: 'Not moving',
  serialized_inactivity: 'Idle unit',
  data_integrity: 'Records need review',
  late_purchase_order: 'Purchase order overdue',
  supplier_price_change: 'Supplier price changed',
};

const CONFIDENCE_NOTE = {
  high: 'Based on a solid run of recent movements.',
  medium: 'Based on a limited run of movements, so treat it as a guide.',
  low: 'Based on very little history — worth a look rather than a decision.',
};

/** Resolves each affected id to a name and a page to open. */
function resolveSubjects(db, workspaceId, item) {
  const ids = item.affectedEntityIds || [];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');

  if (item.affectedEntityType === 'sku') {
    return db
      .prepare(
        `SELECT s.id, i.id AS itemId, i.name, s.variant_label AS variantLabel, s.code
           FROM skus s JOIN items i ON i.id = s.item_id
          WHERE s.workspace_id = ? AND s.id IN (${placeholders})`
      )
      .all(workspaceId, ...ids)
      .map((r) => ({
        id: r.id,
        name: r.variantLabel ? `${r.name} — ${r.variantLabel}` : r.name,
        code: r.code,
        href: `/inventory/${r.itemId}`,
      }));
  }

  if (item.affectedEntityType === 'lot') {
    return db
      .prepare(
        `SELECT lo.id, lo.code, i.id AS itemId, i.name, s.variant_label AS variant
           FROM lots lo JOIN skus s ON s.id = lo.sku_id JOIN items i ON i.id = s.item_id
          WHERE lo.workspace_id = ? AND lo.id IN (${placeholders})`
      )
      .all(workspaceId, ...ids)
      // The variant is part of the name here: one batch code can cover several
      // versions of a product, and three identical chips tell you nothing.
      .map((r) => ({
        id: r.id,
        name: `${[r.name, r.variant].filter(Boolean).join(' · ')} · lot ${r.code}`,
        code: r.code,
        href: `/inventory/${r.itemId}`,
      }));
  }

  if (item.affectedEntityType === 'serial_unit') {
    return db
      .prepare(
        `SELECT su.id, su.serial, i.id AS itemId, i.name
           FROM serial_units su JOIN skus s ON s.id = su.sku_id JOIN items i ON i.id = s.item_id
          WHERE su.workspace_id = ? AND su.id IN (${placeholders})`
      )
      .all(workspaceId, ...ids)
      .map((r) => ({ id: r.id, name: `${r.name} · ${r.serial}`, code: r.serial, href: `/inventory/${r.itemId}` }));
  }

  return [];
}

function resolveLocations(db, workspaceId, item) {
  const ids = item.affectedLocationIds || [];
  if (ids.length === 0) return [];
  return db
    .prepare(
      `SELECT id, name FROM locations
        WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`
    )
    .all(workspaceId, ...ids)
    .map((r) => ({ id: r.id, name: r.name, href: `/inventory?location=${r.id}` }));
}

/** The movements this item pointed at, so "show me" is one click. */
function resolveMovements(db, workspaceId, item) {
  const ids = item.evidenceReferences || [];
  if (ids.length === 0) return [];
  return db
    .prepare(
      `SELECT m.id, m.occurred_at AS occurredAt, m.operation, m.quantity_delta AS delta,
              m.reason_code AS reason, m.notes, l.name AS locationName, u.name AS actorName,
              i.id AS itemId, i.name AS itemName
         FROM movements m
         JOIN locations l ON l.id = m.location_id
         JOIN users u ON u.id = m.actor_user_id
         JOIN items i ON i.id = m.item_id
        WHERE m.workspace_id = ? AND m.id IN (${ids.map(() => '?').join(',')})
        ORDER BY m.occurred_at DESC`
    )
    .all(workspaceId, ...ids);
}

/** Decorates one item for display. */
function present(db, workspaceId, item) {
  return {
    ...item,
    severityLabel: (SEVERITY[item.severity] || {}).label || item.severity,
    severityTone: (SEVERITY[item.severity] || {}).tone || 'muted',
    categoryLabel: CATEGORY_LABEL[item.category] || item.category,
    relatedLabels: (item.relatedCategories || []).map((c) => CATEGORY_LABEL[c] || c),
    confidenceNote: CONFIDENCE_NOTE[item.confidence] || '',
    measuredEvidence: (item.evidence || []).filter((e) => e.kind === 'measured'),
    estimatedEvidence: (item.evidence || []).filter((e) => e.kind === 'estimated'),
    subjects: resolveSubjects(db, workspaceId, item),
    locations: resolveLocations(db, workspaceId, item),
    movements: resolveMovements(db, workspaceId, item),
    isReworded: item.narrativeSource === 'model',
  };
}

function presentAll(db, workspaceId, items) {
  return items.map((item) => present(db, workspaceId, item));
}

/** Groups the briefing the way it is read: what is urgent, then the rest. */
function groupBySeverity(items) {
  const groups = [
    { key: 'critical', ...SEVERITY.critical, items: [] },
    { key: 'important', ...SEVERITY.important, items: [] },
    { key: 'watch', ...SEVERITY.watch, items: [] },
  ];
  for (const item of items) {
    const group = groups.find((g) => g.key === item.severity);
    if (group) group.items.push(item);
  }
  return groups.filter((g) => g.items.length > 0);
}

module.exports = {
  SEVERITY,
  CATEGORY_LABEL,
  CONFIDENCE_NOTE,
  present,
  presentAll,
  groupBySeverity,
  resolveSubjects,
  resolveLocations,
  resolveMovements,
};
