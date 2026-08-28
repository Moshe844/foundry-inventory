'use strict';

/**
 * The deterministic Inventory Signal Engine.
 *
 * Everything here is arithmetic over the Mission 1 ledger. It reads movements,
 * balances, lots and serial units and produces measured facts and clearly
 * labelled estimates — nothing else. No model is consulted at this layer, and
 * nothing here writes to the inventory engine.
 *
 * The distinction the whole mission rests on lives in the shape of the output:
 *
 *   measured  — counted directly from the ledger (onHand, outbound30, …)
 *   estimated — arithmetic on measured values, always with its formula
 *
 * A detector may only reason about these. An interpretation layer may reword
 * them. Neither may invent a number that is not computed here.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const salesOrders = require('../sales/sales-order-service');

/** How much history a usage claim needs before it is worth making. */
const EVIDENCE_FLOOR = {
  minOutboundEvents: 2,
  minOutboundQuantity: 3,
  minObservedDays: 7,
};

function daysAgoIso(days, now = Date.now()) {
  return new Date(now - days * DAY_MS).toISOString();
}

function daysBetween(fromIso, toMs = Date.now()) {
  if (!fromIso) return null;
  const from = new Date(fromIso).getTime();
  if (Number.isNaN(from)) return null;
  return (toMs - from) / DAY_MS;
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Per-SKU signals, optionally narrowed to a set of SKUs so a re-evaluation
 * after one movement does not sweep the whole workspace.
 */
function skuSignals(db, workspaceId, { skuIds = null, now = Date.now(), windowDays = 30 } = {}) {
  const filter = skuIds && skuIds.length ? ` AND s.id IN (${skuIds.map(() => '?').join(',')})` : '';
  const params = skuIds && skuIds.length ? [workspaceId, ...skuIds] : [workspaceId];

  const skus = db
    .prepare(
      `SELECT s.id, s.code, s.variant_label, s.item_id, s.is_active,
              i.name AS item_name, i.tracking_mode, i.has_variants, i.unit_label, i.is_active AS item_active
         FROM skus s
         JOIN items i ON i.id = s.item_id
        WHERE s.workspace_id = ?${filter}`
    )
    .all(...params);

  if (skus.length === 0) return [];

  const committedRows = salesOrders.committedByPosition(db, workspaceId, { skuIds: skus.map((sku) => sku.id) });
  const committedByPosition = new Map(committedRows.map((row) => [
    `${row.sku_id}:${row.location_id}`, Number(row.committed),
  ]));

  const windowStart = daysAgoIso(windowDays, now);
  const priorStart = daysAgoIso(windowDays * 2, now);

  return skus.map((sku) => {
    const balances = db
      .prepare(
        `SELECT b.location_id, b.on_hand, l.name AS location_name, l.kind AS location_kind,
                l.is_active AS location_active
           FROM balances b
           JOIN locations l ON l.id = b.location_id
          WHERE b.workspace_id = ? AND b.sku_id = ?`
      )
      .all(workspaceId, sku.id);

    const onHand = balances.reduce((sum, row) => sum + row.on_hand, 0);
    const committed = balances.reduce((sum, row) =>
      sum + (committedByPosition.get(`${sku.id}:${row.location_id}`) || 0), 0);
    const available = onHand - committed;

    // Consumption is what actually leaves the workspace. A transfer moves
    // stock between our own locations, so it is depletion *at a location* but
    // never demand — conflating them would inflate every usage estimate.
    const flow = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN operation = 'issue' AND occurred_at >= @windowStart THEN -quantity_delta END), 0) AS issued,
           COALESCE(SUM(CASE WHEN operation = 'issue' AND occurred_at >= @priorStart AND occurred_at < @windowStart THEN -quantity_delta END), 0) AS issuedPrior,
           COALESCE(SUM(CASE WHEN operation = 'receive' AND occurred_at >= @windowStart THEN quantity_delta END), 0) AS received,
           COUNT(CASE WHEN operation = 'issue' AND occurred_at >= @windowStart THEN 1 END) AS issueEvents,
           COUNT(CASE WHEN occurred_at >= @windowStart THEN 1 END) AS movementsInWindow,
           MAX(occurred_at) AS lastMovementAt,
           MAX(CASE WHEN operation = 'issue' THEN occurred_at END) AS lastOutboundAt,
           MAX(CASE WHEN operation = 'receive' THEN occurred_at END) AS lastReceivedAt,
           MIN(occurred_at) AS firstMovementAt,
           COUNT(*) AS movementsAllTime
         FROM movements
        WHERE workspace_id = @workspaceId AND sku_id = @skuId`
      )
      .get({ workspaceId, skuId: sku.id, windowStart, priorStart });

    const observedDays = flow.firstMovementAt
      ? Math.min(windowDays, Math.max(0, daysBetween(flow.firstMovementAt, now)))
      : 0;

    const hasUsageEvidence =
      flow.issueEvents >= EVIDENCE_FLOOR.minOutboundEvents &&
      flow.issued >= EVIDENCE_FLOOR.minOutboundQuantity &&
      observedDays >= EVIDENCE_FLOOR.minObservedDays;

    // Averaged over the window actually observed, not a flat 30, so a SKU with
    // ten days of history is not reported as using a third of its real rate.
    const usageWindowDays = hasUsageEvidence ? Math.max(observedDays, 1) : null;
    const averageDailyUsage = hasUsageEvidence ? round(flow.issued / usageWindowDays, 3) : null;
    const daysOfStockRemaining =
      averageDailyUsage && averageDailyUsage > 0 ? round(available / averageDailyUsage, 1) : null;

    const perLocation = balances
      .map((row) => {
        const locFlow = db
          .prepare(
            `SELECT
               COALESCE(SUM(CASE WHEN quantity_delta < 0 AND occurred_at >= @windowStart THEN -quantity_delta END), 0) AS outbound,
               COALESCE(SUM(CASE WHEN operation = 'issue' AND occurred_at >= @windowStart THEN -quantity_delta END), 0) AS issued,
               COALESCE(SUM(CASE WHEN quantity_delta > 0 AND occurred_at >= @windowStart THEN quantity_delta END), 0) AS inbound,
               COUNT(CASE WHEN occurred_at >= @windowStart THEN 1 END) AS movements,
               MAX(occurred_at) AS lastMovementAt
             FROM movements
            WHERE workspace_id = @workspaceId AND sku_id = @skuId AND location_id = @locationId`
          )
          .get({ workspaceId, skuId: sku.id, locationId: row.location_id, windowStart });

        return {
          locationId: row.location_id,
          locationName: row.location_name,
          locationKind: row.location_kind,
          locationArchived: !row.location_active,
          onHand: row.on_hand,
          committed: committedByPosition.get(`${sku.id}:${row.location_id}`) || 0,
          available: row.on_hand - (committedByPosition.get(`${sku.id}:${row.location_id}`) || 0),
          outboundInWindow: locFlow.outbound,
          issuedInWindow: locFlow.issued,
          inboundInWindow: locFlow.inbound,
          movementsInWindow: locFlow.movements,
          daysSinceLastMovement: locFlow.lastMovementAt
            ? round(daysBetween(locFlow.lastMovementAt, now), 1)
            : null,
        };
      })
      .sort((a, b) => b.onHand - a.onHand);

    return {
      skuId: sku.id,
      itemId: sku.item_id,
      code: sku.code,
      variantLabel: sku.variant_label,
      itemName: sku.item_name,
      displayName: sku.variant_label ? `${sku.item_name} / ${sku.variant_label}` : sku.item_name,
      trackingMode: sku.tracking_mode,
      unitLabel: sku.unit_label,
      isActive: Boolean(sku.is_active && sku.item_active),

      measured: {
        onHand,
        committed,
        available,
        locationsHoldingStock: perLocation.filter((l) => l.onHand > 0).length,
        issuedInWindow: flow.issued,
        issuedInPriorWindow: flow.issuedPrior,
        receivedInWindow: flow.received,
        issueEventsInWindow: flow.issueEvents,
        movementsInWindow: flow.movementsInWindow,
        movementsAllTime: flow.movementsAllTime,
        lastMovementAt: flow.lastMovementAt,
        lastOutboundAt: flow.lastOutboundAt,
        lastReceivedAt: flow.lastReceivedAt,
        firstMovementAt: flow.firstMovementAt,
        daysSinceLastMovement: flow.lastMovementAt ? round(daysBetween(flow.lastMovementAt, now), 1) : null,
        daysSinceLastOutbound: flow.lastOutboundAt ? round(daysBetween(flow.lastOutboundAt, now), 1) : null,
        observedDays: round(observedDays, 1),
        windowDays,
      },

      estimated: {
        hasUsageEvidence,
        usageWindowDays: usageWindowDays ? round(usageWindowDays, 1) : null,
        averageDailyUsage,
        daysOfStockRemaining,
        usageTrend:
          flow.issuedPrior > 0 ? round((flow.issued - flow.issuedPrior) / flow.issuedPrior, 2) : null,
      },

      perLocation,
    };
  });
}

/** Adjustment history for a SKU, with the baseline a detector compares against. */
function adjustmentSignals(db, workspaceId, { skuIds = null, now = Date.now(), lookbackDays = 180 } = {}) {
  const filter = skuIds && skuIds.length ? ` AND a.sku_id IN (${skuIds.map(() => '?').join(',')})` : '';
  const params = skuIds && skuIds.length ? [workspaceId, daysAgoIso(lookbackDays, now), ...skuIds] : [workspaceId, daysAgoIso(lookbackDays, now)];

  const rows = db
    .prepare(
      `SELECT a.id, a.sku_id, a.location_id, a.expected_qty, a.counted_qty, a.reason_code,
              a.notes, a.created_at, a.movement_id, a.actor_user_id,
              u.name AS actor_name, l.name AS location_name,
              s.variant_label, i.name AS item_name, i.id AS item_id,
              m.seq AS movement_seq,
              -- The first thing that ever happened to this product at this
              -- location. An adjustment that IS that first thing established the
              -- position rather than corrected it.
              (SELECT MIN(m2.seq) FROM movements m2
                WHERE m2.workspace_id = a.workspace_id
                  AND m2.sku_id = a.sku_id
                  AND m2.location_id = a.location_id) AS first_movement_seq
         FROM adjustments a
         JOIN users u ON u.id = a.actor_user_id
         JOIN locations l ON l.id = a.location_id
         JOIN skus s ON s.id = a.sku_id
         JOIN items i ON i.id = s.item_id
         LEFT JOIN movements m ON m.id = a.movement_id
        WHERE a.workspace_id = ? AND a.created_at >= ?${filter}
        ORDER BY a.created_at`
    )
    .all(...params);

  const bySku = new Map();
  for (const row of rows) {
    if (!bySku.has(row.sku_id)) bySku.set(row.sku_id, []);
    bySku.get(row.sku_id).push({
      adjustmentId: row.id,
      movementId: row.movement_id,
      skuId: row.sku_id,
      itemId: row.item_id,
      locationId: row.location_id,
      locationName: row.location_name,
      displayName: row.variant_label ? `${row.item_name} / ${row.variant_label}` : row.item_name,
      expected: row.expected_qty,
      counted: row.counted_qty,
      delta: row.counted_qty - row.expected_qty,
      magnitude: Math.abs(row.counted_qty - row.expected_qty),
      reasonCode: row.reason_code,
      notes: row.notes,
      actorName: row.actor_name,
      actorId: row.actor_user_id,
      createdAt: row.created_at,
      daysAgo: round(daysBetween(row.created_at, now), 1),
      // Opening stock, not a correction: the first movement this product ever
      // had at this location, starting from nothing. A zero balance with no
      // history behind it is the absence of a measurement, not a measurement of
      // an empty shelf, so there is nothing for the figure to be unusual
      // against. Read from the ledger rather than from the reason someone
      // typed, because the ledger cannot be worded differently.
      establishesPosition:
        row.expected_qty === 0 &&
        row.movement_seq !== null &&
        row.movement_seq === row.first_movement_seq,
    });
  }

  return [...bySku.entries()].map(([skuId, adjustments]) => {
    const magnitudes = adjustments.map((a) => a.magnitude).sort((a, b) => a - b);
    const median = magnitudes.length
      ? magnitudes.length % 2
        ? magnitudes[(magnitudes.length - 1) / 2]
        : (magnitudes[magnitudes.length / 2 - 1] + magnitudes[magnitudes.length / 2]) / 2
      : 0;

    return {
      skuId,
      adjustments,
      baseline: {
        count: adjustments.length,
        medianMagnitude: median,
        maxMagnitude: magnitudes.length ? magnitudes[magnitudes.length - 1] : 0,
        typicalRange: magnitudes.length
          ? { low: magnitudes[0], high: magnitudes[Math.max(0, magnitudes.length - 2)] }
          : null,
      },
    };
  });
}

/** Lot signals, including expiry proximity and whether usage can clear a lot. */
function lotSignals(db, workspaceId, { skuIds = null, now = Date.now(), windowDays = 30 } = {}) {
  const filter = skuIds && skuIds.length ? ` AND lo.sku_id IN (${skuIds.map(() => '?').join(',')})` : '';
  const params = skuIds && skuIds.length ? [workspaceId, ...skuIds] : [workspaceId];

  const lots = db
    .prepare(
      `SELECT lo.id, lo.code, lo.sku_id, lo.expires_at, lo.received_at,
              s.variant_label, s.item_id, i.name AS item_name, i.unit_label,
              COALESCE(SUM(lb.quantity), 0) AS quantity
         FROM lots lo
         JOIN skus s ON s.id = lo.sku_id
         JOIN items i ON i.id = s.item_id
         LEFT JOIN lot_balances lb ON lb.lot_id = lo.id
        WHERE lo.workspace_id = ?${filter}
        GROUP BY lo.id`
    )
    .all(...params)
    .filter((lot) => lot.quantity > 0);

  if (lots.length === 0) return [];

  const usageBySku = new Map(
    skuSignals(db, workspaceId, { skuIds: [...new Set(lots.map((l) => l.sku_id))], now, windowDays }).map(
      (s) => [s.skuId, s]
    )
  );

  return lots.map((lot) => {
    const locations = db
      .prepare(
        `SELECT lb.location_id, lb.quantity, l.name AS location_name
           FROM lot_balances lb
           JOIN locations l ON l.id = lb.location_id
          WHERE lb.workspace_id = ? AND lb.lot_id = ? AND lb.quantity <> 0`
      )
      .all(workspaceId, lot.id);

    const daysToExpiry = lot.expires_at
      ? round((new Date(lot.expires_at).getTime() - now) / DAY_MS, 1)
      : null;

    const usage = usageBySku.get(lot.sku_id);
    const dailyUsage = usage && usage.estimated.hasUsageEvidence ? usage.estimated.averageDailyUsage : null;

    // How much of this lot recent usage would plausibly consume before it
    // expires. An estimate, and labelled as one everywhere it is shown.
    const projectedRemaining =
      dailyUsage !== null && daysToExpiry !== null && daysToExpiry > 0
        ? Math.max(0, round(lot.quantity - dailyUsage * daysToExpiry, 0))
        : null;

    return {
      lotId: lot.id,
      code: lot.code,
      skuId: lot.sku_id,
      itemId: lot.item_id,
      unitLabel: lot.unit_label,
      displayName: lot.variant_label ? `${lot.item_name} / ${lot.variant_label}` : lot.item_name,
      measured: {
        quantity: lot.quantity,
        expiresAt: lot.expires_at,
        receivedAt: lot.received_at,
        locations: locations.map((l) => ({
          locationId: l.location_id,
          locationName: l.location_name,
          quantity: l.quantity,
        })),
      },
      estimated: {
        daysToExpiry,
        expired: daysToExpiry !== null && daysToExpiry < 0,
        averageDailyUsage: dailyUsage,
        projectedRemainingAtExpiry: projectedRemaining,
      },
    };
  });
}

/** Serialized units and how long each has sat where it is. */
function serialSignals(db, workspaceId, { skuIds = null, now = Date.now() } = {}) {
  const filter = skuIds && skuIds.length ? ` AND su.sku_id IN (${skuIds.map(() => '?').join(',')})` : '';
  const params = skuIds && skuIds.length ? [workspaceId, ...skuIds] : [workspaceId];

  return db
    .prepare(
      `SELECT su.id, su.serial, su.status, su.condition, su.location_id, su.sku_id, su.updated_at,
              l.name AS location_name, s.variant_label, s.item_id, i.name AS item_name,
              (SELECT MAX(m.occurred_at) FROM movements m WHERE m.serial_unit_id = su.id) AS lastMovementAt
         FROM serial_units su
         LEFT JOIN locations l ON l.id = su.location_id
         JOIN skus s ON s.id = su.sku_id
         JOIN items i ON i.id = s.item_id
        WHERE su.workspace_id = ? AND su.status = 'in_stock'${filter}`
    )
    .all(...params)
    .map((unit) => ({
      unitId: unit.id,
      serial: unit.serial,
      skuId: unit.sku_id,
      itemId: unit.item_id,
      locationId: unit.location_id,
      locationName: unit.location_name,
      condition: unit.condition,
      displayName: unit.variant_label ? `${unit.item_name} / ${unit.variant_label}` : unit.item_name,
      measured: {
        status: unit.status,
        lastMovementAt: unit.lastMovementAt,
        daysSinceLastMovement: unit.lastMovementAt
          ? round(daysBetween(unit.lastMovementAt, now), 1)
          : null,
      },
    }));
}

/** Workspace-wide facts a detector or a brief may need. */
function workspaceSignals(db, workspaceId, { now = Date.now(), windowDays = 30 } = {}) {
  const windowStart = daysAgoIso(windowDays, now);
  const totals = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM items WHERE workspace_id = @workspaceId AND is_active = 1) AS activeItems,
         (SELECT COUNT(*) FROM locations WHERE workspace_id = @workspaceId AND is_active = 1) AS activeLocations,
         (SELECT COALESCE(SUM(on_hand), 0) FROM balances WHERE workspace_id = @workspaceId) AS unitsOnHand,
         (SELECT COUNT(*) FROM movements WHERE workspace_id = @workspaceId AND occurred_at >= @windowStart) AS movementsInWindow,
         (SELECT COUNT(*) FROM movements WHERE workspace_id = @workspaceId) AS movementsAllTime`
    )
    .get({ workspaceId, windowStart });

  return { ...totals, windowDays, evaluatedAt: new Date(now).toISOString() };
}

module.exports = {
  skuSignals,
  adjustmentSignals,
  lotSignals,
  serialSignals,
  workspaceSignals,
  daysAgoIso,
  daysBetween,
  round,
  EVIDENCE_FLOOR,
  DAY_MS,
};
