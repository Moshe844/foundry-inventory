'use strict';

/**
 * Deterministic detectors.
 *
 * Each takes measured signals and returns candidate attention items. Every
 * candidate carries the evidence that produced it, so "why is Foundry telling
 * me this?" is answerable without re-deriving anything — and so a detector can
 * never assert something the ledger does not support.
 *
 * Detectors stay silent when the evidence is thin. A quiet briefing on sparse
 * data is correct; a confident one would be a lie.
 */

const { THRESHOLDS, DETECTION_RULE_VERSION } = require('./policy');
const { round, daysBetween } = require('../signals/signal-engine');
const replenishmentPlan = require('../purchasing/replenishment-plan');

const fact = (label, value, kind = 'measured') => ({ label, value: String(value), kind });

/** "1 day ago", not "1 days ago". */
function daysAgoText(days) {
  const whole = Math.round(days);
  if (whole <= 0) return 'today';
  return `${whole} ${whole === 1 ? 'day' : 'days'} ago`;
}

const dayCount = (days) => {
  const whole = Math.round(days);
  return `${whole} ${whole === 1 ? 'day' : 'days'}`;
};

// One implementation, shared with the views: see lib/units.
const { unitCount } = require('../lib/units');

function candidate(fields) {
  return { detectionRuleVersion: DETECTION_RULE_VERSION, relatedCategories: [], ...fields };
}

/**
 * What is already on its way for this product, if anything.
 *
 * Mission 6 gave the attention layer a second fact about every line, and it
 * changes what is worth saying: "you have none left" and "you have none left
 * and 48 arrive on Friday" are different situations, and treating them the same
 * sends someone to buy stock they have already bought.
 */
function incomingFor(signals, skuId) {
  const map = signals.purchasing && signals.purchasing.incoming;
  if (!map || typeof map.get !== 'function') return null;
  const entry = map.get(skuId);
  return entry && entry.onOrder > 0 ? entry : null;
}

function incomingText(incoming) {
  if (!incoming) return '';
  const when = incoming.nextExpectedDate ? `, expected ${incoming.nextExpectedDate}` : '';
  const orders = incoming.orders && incoming.orders.length
    ? ` on ${incoming.orders.map((o) => o.poNumber).join(', ')}`
    : '';
  return `${incoming.onOrder} on order${orders}${when}`;
}

/** Something that is moving has run out entirely. */
function detectLowStock(signals) {
  const out = [];
  for (const sku of signals.skus) {
    if (!sku.isActive) continue;
    if (sku.measured.onHand > 0) continue;

    const recentlyActive =
      sku.measured.daysSinceLastOutbound !== null &&
      sku.measured.daysSinceLastOutbound <= THRESHOLDS.lowStock.recentlyActiveDays;
    if (!recentlyActive) continue; // never-moved stock at zero is not news

    // Being out of stock is still worth knowing even when a delivery is booked
    // — you cannot sell what has not arrived — but it is not the same emergency,
    // and the card says what is coming instead of implying nothing is.
    const incoming = incomingFor(signals, sku.skuId);

    out.push(
      candidate({
        category: 'low_stock',
        severity: incoming ? 'important' : 'critical',
        confidence: 'high',
        fingerprint: `low_stock:${sku.skuId}`,
        title: `${sku.displayName} is out of stock`,
        conciseSummary: incoming
          ? `0 on hand · ${incomingText(incoming)}`
          : `0 on hand · last issued ${daysAgoText(sku.measured.daysSinceLastOutbound)}`,
        explanation:
          `There is nothing on hand anywhere, and this ${sku.unitLabel} was still being issued ` +
          `${Math.round(sku.measured.daysSinceLastOutbound)} days ago ` +
          `(${sku.measured.issuedInWindow} issued in the last ${sku.measured.windowDays} days).` +
          (incoming ? ` ${incomingText(incoming)}, so a delivery is already booked.` : ''),
        recommendation: incoming
          ? 'Nothing to order — check whether the delivery is on track.'
          : 'Review replenishment for this line.',
        affectedEntityType: 'sku',
        affectedEntityIds: [sku.skuId],
        affectedLocationIds: [],
        evidence: [
          fact('On hand', 0),
          fact('On order', incoming ? incoming.onOrder : 0,
            incoming && incoming.nextExpectedDate ? `next expected ${incoming.nextExpectedDate}` : null),
          fact(`Issued in last ${sku.measured.windowDays} days`, sku.measured.issuedInWindow),
          fact('Last issued', `${Math.round(sku.measured.daysSinceLastOutbound)} days ago`),
          fact('Last received', sku.measured.lastReceivedAt ? sku.measured.lastReceivedAt.slice(0, 10) : 'never'),
        ],
        metrics: {
          onHand: 0,
          onOrder: incoming ? incoming.onOrder : 0,
          issuedInWindow: sku.measured.issuedInWindow,
          daysSinceLastOutbound: sku.measured.daysSinceLastOutbound,
        },
        skuId: sku.skuId,
        itemId: sku.itemId,
      })
    );
  }
  return out;
}

/** Recent usage suggests this will reach zero soon. */
function detectStockoutRisk(signals) {
  const out = [];
  for (const sku of signals.skus) {
    if (!sku.isActive) continue;
    if (sku.measured.onHand <= 0) continue;               // that is low_stock, not a forecast
    if (!sku.estimated.hasUsageEvidence) continue;         // no honest basis for a claim
    const days = sku.estimated.daysOfStockRemaining;
    if (days === null || days > THRESHOLDS.stockout.watchDays) continue;

    // The Mission 6 question: is this actually a problem, or has somebody
    // already dealt with it? A delivery that lands before the shelf empties
    // means there is nothing to warn about, and warning anyway is how software
    // teaches people to ignore it.
    const incoming = incomingFor(signals, sku.skuId);
    if (incoming) {
      const usage = sku.estimated.averageDailyUsage;
      const coveredDays = usage > 0 ? (sku.measured.onHand + incoming.onOrder) / usage : null;
      const arrivesInDays = incoming.nextExpectedDate
        ? (Date.parse(`${incoming.nextExpectedDate}T23:59:59Z`) - Date.now()) / (24 * 60 * 60 * 1000)
        : null;
      const arrivesInTime = arrivesInDays !== null && arrivesInDays <= days;
      const comfortablyCovered = coveredDays !== null && coveredDays > THRESHOLDS.stockout.watchDays;
      if (arrivesInTime || comfortablyCovered) continue;
    }

    const severity =
      days <= THRESHOLDS.stockout.criticalDays
        ? 'critical'
        : days <= THRESHOLDS.stockout.importantDays
          ? 'important'
          : 'watch';

    // More observed history means more trust in the rate.
    const confidence =
      sku.measured.issueEventsInWindow >= 5 && sku.measured.observedDays >= 21
        ? 'high'
        : sku.measured.issueEventsInWindow >= 3
          ? 'medium'
          : 'low';

    // Where it is, said accurately: naming one location when the stock is
    // spread over three would send someone to the wrong shelf.
    const stocked = sku.perLocation.filter((l) => l.onHand > 0);
    const where =
      stocked.length === 1
        ? ` at ${stocked[0].locationName}`
        : stocked.length > 1
          ? ` across ${stocked.length} locations`
          : '';

    out.push(
      candidate({
        category: 'stockout_risk',
        severity,
        confidence,
        fingerprint: `stockout_risk:${sku.skuId}`,
        title: `${sku.displayName} may run out`,
        conciseSummary:
          `${sku.measured.onHand} left${where} · roughly ${Math.round(days)} days at recent usage` +
          (incoming ? ` · ${incomingText(incoming)}` : ''),
        explanation:
          `${sku.measured.issuedInWindow} were issued in the last ${sku.measured.windowDays} days ` +
          `across ${sku.measured.issueEventsInWindow} movements, about ` +
          `${sku.estimated.averageDailyUsage} per day. At that rate the ${sku.measured.onHand} on hand ` +
          `lasts roughly ${Math.round(days)} days.`,
        recommendation: 'Foundry recommends reviewing replenishment.',
        affectedEntityType: 'sku',
        affectedEntityIds: [sku.skuId],
        affectedLocationIds: sku.perLocation.filter((l) => l.onHand > 0).map((l) => l.locationId),
        evidence: [
          fact('Current stock', sku.measured.onHand),
          fact(`Issued in last ${sku.measured.windowDays} days`, sku.measured.issuedInWindow),
          fact(`Issued in previous ${sku.measured.windowDays} days`, sku.measured.issuedInPriorWindow),
          fact('Movements counted', sku.measured.issueEventsInWindow),
          fact('History observed', `${sku.measured.observedDays} days`),
          fact(
            'Calculation',
            `${sku.measured.issuedInWindow} ÷ ${sku.estimated.usageWindowDays} days = ${sku.estimated.averageDailyUsage}/day`,
            'estimated'
          ),
          fact(
            'Estimated stock remaining',
            `${sku.measured.onHand} ÷ ${sku.estimated.averageDailyUsage} ≈ ${Math.round(days)} days`,
            'estimated'
          ),
        ],
        metrics: {
          onHand: sku.measured.onHand,
          issuedInWindow: sku.measured.issuedInWindow,
          averageDailyUsage: sku.estimated.averageDailyUsage,
          daysOfStockRemaining: days,
        },
        skuId: sku.skuId,
        itemId: sku.itemId,
      })
    );
  }
  return out;
}

/** One location is short of stock it is using while another sits on it. */
function detectLocationImbalance(signals, options = {}) {
  const out = [];
  const t = THRESHOLDS.imbalance;

  // A line with a configured reorder point is the replenishment planner's, not
  // this one's. Two engines proposing movements for the same product is how
  // "move all 45 to Downtown" ended up printed beside "order 36 from ABC".
  const planned = (options.replenishment && options.replenishment.governedSkuIds) || new Set();

  for (const sku of signals.skus) {
    if (!sku.isActive) continue;
    if (planned.has(sku.skuId)) continue;
    if (sku.measured.onHand < t.minTotalOnHand) continue;
    if (sku.perLocation.length < 2) continue;

    const byDemand = [...sku.perLocation].sort((a, b) => b.outboundInWindow - a.outboundInWindow);
    const busy = byDemand[0];
    const quiet = [...sku.perLocation].sort((a, b) => b.onHand - a.onHand)[0];

    if (!busy || !quiet || busy.locationId === quiet.locationId) continue;
    if (busy.outboundInWindow < t.minBusyLocationOutbound) continue;
    if (quiet.onHand < t.minQuietLocationOnHand) continue;

    // The busy location must be materially shorter, and the other materially slower.
    const stockRatio = quiet.onHand / Math.max(busy.onHand, 1);
    const outboundRatio = busy.outboundInWindow / Math.max(quiet.outboundInWindow, 1);
    if (stockRatio < t.minStockRatio || outboundRatio < t.minOutboundRatio) continue;

    // Only suggest a move that leaves the quiet location covered for itself.
    const quietDailyUse = quiet.outboundInWindow / sku.measured.windowDays;
    const quietKeep = Math.ceil(quietDailyUse * 30);
    const suggested = Math.max(0, Math.min(Math.floor((quiet.onHand - busy.onHand) / 2), quiet.onHand - quietKeep));
    if (suggested < 1) continue;

    out.push(
      candidate({
        category: 'location_imbalance',
        severity: busy.onHand === 0 ? 'important' : 'watch',
        confidence: busy.outboundInWindow >= 10 ? 'high' : 'medium',
        fingerprint: `location_imbalance:${sku.skuId}`,
        title: `${sku.displayName} may be better balanced`,
        conciseSummary: `${busy.locationName}: ${busy.onHand} · ${quiet.locationName}: ${quiet.onHand}`,
        explanation:
          `${busy.locationName} has issued ${busy.outboundInWindow} in the last ${sku.measured.windowDays} days ` +
          `but holds ${busy.onHand}. ${quiet.locationName} holds ${quiet.onHand} and has issued ` +
          `${quiet.outboundInWindow} over the same period.`,
        recommendation:
          `Consider reviewing a transfer of about ${suggested} from ${quiet.locationName} to ${busy.locationName}.`,
        affectedEntityType: 'sku',
        affectedEntityIds: [sku.skuId],
        affectedLocationIds: [busy.locationId, quiet.locationId],
        evidence: [
          fact(`${busy.locationName} on hand`, busy.onHand),
          fact(`${busy.locationName} outbound (${sku.measured.windowDays}d)`, busy.outboundInWindow),
          fact(`${quiet.locationName} on hand`, quiet.onHand),
          fact(`${quiet.locationName} outbound (${sku.measured.windowDays}d)`, quiet.outboundInWindow),
          fact('Suggested quantity to review', suggested, 'estimated'),
        ],
        metrics: {
          busyLocationId: busy.locationId,
          busyOnHand: busy.onHand,
          busyOutbound: busy.outboundInWindow,
          quietLocationId: quiet.locationId,
          quietOnHand: quiet.onHand,
          quietOutbound: quiet.outboundInWindow,
          suggestedTransferQuantity: suggested,
        },
        skuId: sku.skuId,
        itemId: sku.itemId,
      })
    );
  }
  return out;
}

/**
 * An adjustment far outside this SKU's usual corrections. An operational
 * anomaly worth a look — never an accusation.
 */
function detectUnusualAdjustment(signals) {
  const out = [];
  const t = THRESHOLDS.adjustment;
  const cutoffDays = t.lookbackDays;

  for (const group of signals.adjustments) {
    const recent = group.adjustments.filter((a) => a.daysAgo <= cutoffDays);
    if (recent.length === 0) continue;

    for (const adjustment of recent) {
      // Establishing opening stock is not a correction.
      //
      // Somebody entering what is on the shelf for the first time produces an
      // adjustment from nothing to whatever is there, and the larger the
      // business the larger that number. Judged as a correction it is a 100%
      // swing every time, so a clean setup filled Needs you with exceptions
      // for the entirely expected act of telling Foundry what it holds.
      //
      // It is skipped on the shape of the ledger — first movement at this
      // position, from zero — and not on the reason text, which anyone can
      // word differently. A later correction to the same position has movements
      // behind it and is still judged normally.
      if (adjustment.establishesPosition) continue;

      // Openings are excluded from the baseline as well as from detection. A
      // +50 opening balance sitting in the history would define "normal
      // correction" as fifty units and quietly hide the real anomalies that
      // followed it.
      const priors = group.adjustments.filter(
        (a) => a.createdAt < adjustment.createdAt && !a.establishesPosition
      );
      const hasBaseline = priors.length >= t.minBaselineCount;

      let unusual = false;
      let comparison = '';

      if (hasBaseline) {
        const magnitudes = priors.map((a) => a.magnitude).sort((a, b) => a - b);
        const median =
          magnitudes.length % 2
            ? magnitudes[(magnitudes.length - 1) / 2]
            : (magnitudes[magnitudes.length / 2 - 1] + magnitudes[magnitudes.length / 2]) / 2;
        const threshold = Math.max(median * t.magnitudeMultiple, t.absoluteFloor);
        unusual = adjustment.magnitude >= threshold;
        comparison =
          `Recent corrections for this line ranged ${magnitudes[0]}–${magnitudes[magnitudes.length - 1]} ` +
          `(typically ${median}).`;
      } else {
        // No baseline: judge against the balance the count was correcting.
        const share = adjustment.expected > 0 ? adjustment.magnitude / adjustment.expected : 1;
        unusual =
          adjustment.magnitude >= t.noBaselineFloor && share >= t.noBaselineShareOfExpected;
        comparison = 'There is not much adjustment history for this line yet to compare against.';
      }

      if (!unusual) continue;

      out.push(
        candidate({
          category: 'unusual_adjustment',
          severity: adjustment.magnitude >= 25 ? 'important' : 'watch',
          confidence: hasBaseline ? 'high' : 'medium',
          fingerprint: `unusual_adjustment:${adjustment.adjustmentId}`,
          title: `Unusual adjustment on ${adjustment.displayName}`,
          conciseSummary:
            `${adjustment.delta > 0 ? '+' : ''}${adjustment.delta} at ${adjustment.locationName} · ` +
            `${daysAgoText(adjustment.daysAgo)}`,
          explanation:
            `${adjustment.actorName} recorded a correction from ${adjustment.expected} to ` +
            `${adjustment.counted} at ${adjustment.locationName}. ${comparison}`,
          recommendation: 'Worth confirming the count and the reason with whoever recorded it.',
          affectedEntityType: 'sku',
          affectedEntityIds: [adjustment.skuId],
          affectedLocationIds: [adjustment.locationId],
          evidenceReferences: [adjustment.movementId],
          evidence: [
            fact('Before', adjustment.expected),
            fact('After', adjustment.counted),
            fact('Change', `${adjustment.delta > 0 ? '+' : ''}${adjustment.delta}`),
            fact('Recorded by', adjustment.actorName),
            fact('Reason given', adjustment.reasonCode || 'not stated'),
            fact('Location', adjustment.locationName),
            fact('Comparison', comparison, 'measured'),
          ],
          metrics: {
            adjustmentId: adjustment.adjustmentId,
            delta: adjustment.delta,
            magnitude: adjustment.magnitude,
            expected: adjustment.expected,
            counted: adjustment.counted,
            baselineMedian: hasBaseline ? group.baseline.medianMagnitude : null,
            priorAdjustments: priors.length,
          },
          skuId: adjustment.skuId,
          itemId: adjustment.itemId,
          occurredAt: adjustment.createdAt,
        })
      );
    }
  }
  return out;
}

/**
 * Lots approaching or past expiry while quantity remains.
 *
 * A lot belongs to one product in the records, but a batch code usually names
 * something physical — one roast, one bake, one delivery — and a business that
 * bags a single roast into three sizes has one batch to decide about, not
 * three. Where a code and an expiry date are shared across products they are
 * reported once, with every product named and its share shown. A code used by
 * one product is reported exactly as before, under its original fingerprint,
 * so nothing already open churns.
 */
function detectExpiringInventory(signals) {
  const t = THRESHOLDS.expiration;
  const qualifying = [];

  for (const lot of signals.lots) {
    const days = lot.estimated.daysToExpiry;
    if (days === null) continue;
    if (lot.measured.quantity < t.minQuantity) continue;
    if (days > t.watchDays) continue;
    qualifying.push({ lot, days });
  }

  // Same code, same date: one batch.
  const batches = new Map();
  for (const entry of qualifying) {
    const key = `${String(entry.lot.code).toLowerCase()}|${entry.lot.measured.expiresAt.slice(0, 10)}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(entry);
  }

  const out = [];
  for (const group of batches.values()) {
    const products = new Set(group.map((entry) => entry.lot.skuId));
    if (products.size >= t.rollUpAcrossProductsAt) out.push(rolledUpBatch(group));
    else out.push(...group.map(singleLot));
  }
  return out;
}

const severityFor = (days) => {
  const t = THRESHOLDS.expiration;
  return days < 0 || days <= t.criticalDays ? 'critical' : days <= t.importantDays ? 'important' : 'watch';
};

/** The projection sentence, when there is enough usage history to make one. */
function projectionText(projected) {
  return projected !== null && projected > 0
    ? ` At recent usage, approximately ${projected} may remain when it expires.`
    : '';
}

function singleLot({ lot, days }) {
  const where = lot.measured.locations.map((l) => `${l.locationName} (${l.quantity})`).join(', ');

  const evidence = [
    fact('Quantity remaining', lot.measured.quantity),
    fact('Expires', lot.measured.expiresAt.slice(0, 10)),
    fact('Days remaining', days < 0 ? `expired ${Math.abs(Math.round(days))} days ago` : Math.round(days)),
    fact('Held at', where || 'no location'),
  ];
  if (lot.estimated.projectedRemainingAtExpiry !== null) {
    evidence.push(
      fact('Recent usage', `${lot.estimated.averageDailyUsage}/day`, 'estimated'),
      fact('Projected remaining at expiry', `about ${lot.estimated.projectedRemainingAtExpiry}`, 'estimated')
    );
  }

  return candidate({
    category: 'expiring_inventory',
    severity: severityFor(days),
    confidence: 'high',
    fingerprint: `expiring_inventory:${lot.lotId}`,
    title: days < 0 ? `Lot ${lot.code} has expired` : `Lot ${lot.code} expires in ${Math.round(days)} days`,
    conciseSummary: `${unitCount(lot.measured.quantity, lot.unitLabel)} of ${lot.displayName}${where ? ` · ${where}` : ''}`,
    explanation:
      days < 0
        ? `${lot.measured.quantity} units of ${lot.displayName} from lot ${lot.code} passed their expiry date ${Math.abs(Math.round(days))} days ago.`
        : `${lot.measured.quantity} units of ${lot.displayName} from lot ${lot.code} expire on ${lot.measured.expiresAt.slice(0, 10)}.${projectionText(lot.estimated.projectedRemainingAtExpiry)}`,
    recommendation:
      days < 0
        ? 'Review this lot and record what happened to it.'
        : 'Prioritise this lot for issue, or plan what to do with the remainder.',
    affectedEntityType: 'lot',
    affectedEntityIds: [lot.lotId],
    affectedLocationIds: lot.measured.locations.map((l) => l.locationId),
    evidence,
    metrics: {
      lotId: lot.lotId,
      quantity: lot.measured.quantity,
      daysToExpiry: days,
      projectedRemainingAtExpiry: lot.estimated.projectedRemainingAtExpiry,
    },
    skuId: lot.skuId,
    itemId: lot.itemId,
  });
}

/** One physical batch, several products. */
function rolledUpBatch(group) {
  const sorted = [...group].sort((a, b) => b.lot.measured.quantity - a.lot.measured.quantity);
  const first = sorted[0].lot;
  // The soonest date in the batch governs it — a batch is as urgent as its
  // earliest member, never its average.
  const days = Math.min(...sorted.map((entry) => entry.days));
  const total = sorted.reduce((sum, entry) => sum + entry.lot.measured.quantity, 0);
  const date = first.measured.expiresAt.slice(0, 10);

  const locations = new Map();
  for (const entry of sorted) {
    for (const location of entry.lot.measured.locations) {
      locations.set(location.locationId, {
        name: location.locationName,
        quantity: (locations.get(location.locationId) || { quantity: 0 }).quantity + location.quantity,
      });
    }
  }
  const where = [...locations.values()].map((l) => `${l.name} (${l.quantity})`).join(', ');
  const names = sorted.map((entry) => entry.lot.displayName);

  // Every product's share is named, so rolling up hides nothing.
  const evidence = [
    fact('Quantity remaining', total),
    fact('Expires', date),
    fact('Days remaining', days < 0 ? `expired ${Math.abs(Math.round(days))} days ago` : Math.round(days)),
    fact('Products in this batch', sorted.length),
    ...sorted.map((entry) => fact(entry.lot.displayName, entry.lot.measured.quantity)),
    fact('Held at', where || 'no location'),
  ];

  const projected = sorted.reduce(
    (sum, entry) =>
      entry.lot.estimated.projectedRemainingAtExpiry === null
        ? sum
        : (sum || 0) + entry.lot.estimated.projectedRemainingAtExpiry,
    null
  );

  return candidate({
    category: 'expiring_inventory',
    severity: severityFor(days),
    confidence: 'high',
    // Keyed on the batch itself rather than on any one of its lot rows, so the
    // finding survives one of its products selling out.
    fingerprint: `expiring_inventory:batch:${String(first.code).toLowerCase()}:${date}`,
    title: days < 0 ? `Lot ${first.code} has expired` : `Lot ${first.code} expires in ${Math.round(days)} days`,
    conciseSummary: `${unitCount(total, first.unitLabel)} across ${sorted.length} products${where ? ` · ${where}` : ''}`,
    explanation:
      (days < 0
        ? `${total} units from lot ${first.code} passed their expiry date ${Math.abs(Math.round(days))} days ago.`
        : `${total} units from lot ${first.code} expire on ${date}.${projectionText(projected)}`) +
      ` It is one batch across ${sorted.length} products: ${names.join(', ')}.`,
    recommendation:
      days < 0
        ? 'Review this batch and record what happened to it.'
        : 'Prioritise this batch for issue, or plan what to do with the remainder.',
    affectedEntityType: 'lot',
    affectedEntityIds: sorted.map((entry) => entry.lot.lotId),
    affectedLocationIds: [...locations.keys()],
    evidence,
    metrics: {
      lotCode: first.code,
      lotIds: sorted.map((entry) => entry.lot.lotId),
      products: sorted.length,
      quantity: total,
      daysToExpiry: days,
      projectedRemainingAtExpiry: projected,
    },
    // The largest holding, so the card still links somewhere useful. Every
    // product appears in the evidence and as its own chip.
    skuId: first.skuId,
    itemId: first.itemId,
  });
}

/**
 * A configured reorder point has been crossed, and here is the whole answer.
 *
 * This is the one card for the situation. It does not say "stock is low" and
 * leave the reader to go and find Reorder Settings, and it does not appear
 * beside a separate transfer suggestion that assumed the order would not
 * happen: the plan behind it decided between moving stock, buying stock, both
 * or neither, from the same set of facts, in one pass.
 *
 * Nothing here is computed. The arithmetic belongs to the planner, and this
 * turns one plan into one card so that what is shown and what was decided
 * cannot drift apart.
 */
function detectReplenishment(signals, options = {}) {
  const planned = (options.replenishment && options.replenishment.actionable) || [];
  const out = [];

  for (const plan of planned) {
    const moved = plan.transfers.reduce((total, move) => total + move.quantity, 0);
    const severity =
      plan.onHandTotal === 0 ? 'critical'
        : plan.blocked ? 'important'
          : plan.networkPosition <= (plan.safetyStock || 0) ? 'critical'
            : 'important';

    const evidence = [
      fact('On hand', plan.onHandTotal),
      ...plan.byLocation.map((loc) =>
        fact(`${loc.locationName} on hand`, loc.onHand, 'measured')),
      fact('On order', plan.onOrder),
      fact('Position', plan.networkPosition),
      fact('Reorder point', plan.reorderPoint, plan.policySource === 'foundry' ? 'estimated' : 'measured'),
      fact('Order up to', plan.target, plan.policySource === 'foundry' ? 'estimated' : 'measured'),
    ];
    for (const loc of plan.byLocation) {
      if (loc.reserveFloor > 0) evidence.push(fact(`${loc.locationName} reserve`, loc.reserveFloor));
    }
    if (plan.purchase) {
      evidence.push(fact('Supplier', plan.purchase.supplierName));
      evidence.push(fact('Lead time', `${plan.purchase.leadTimeDays} days`,
        plan.purchase.leadTimeAssumed ? 'estimated' : 'measured'));
    }

    const recommendation = replenishmentPlan.recommendationFor(plan);

    out.push(
      candidate({
        category: 'replenishment_needed',
        severity,
        confidence: 'high',
        fingerprint: `replenishment_needed:${plan.skuId}`,
        title: plan.blocked === 'no_supplier'
          ? `${plan.displayName} is below its reorder point, with no supplier`
          : `${plan.displayName}: ${plan.headline.toLowerCase()}`,
        conciseSummary:
          `${plan.onHandTotal} on hand${plan.onOrder ? ` · ${plan.onOrder} on order` : ''} ` +
          `· reorder at ${plan.reorderPoint}`,
        explanation: plan.explanation,
        recommendation: plan.blocked === 'no_supplier'
          ? 'Add a supplier for this line and Foundry can work out the quantity.'
          : recommendation,
        affectedEntityType: 'sku',
        affectedEntityIds: [plan.skuId],
        affectedLocationIds: plan.byLocation.map((loc) => loc.locationId),
        evidence,
        metrics: {
          decision: plan.decision,
          onHand: plan.onHandTotal,
          onOrder: plan.onOrder,
          position: plan.networkPosition,
          reorderPoint: plan.reorderPoint,
          target: plan.target,
          transferUnits: moved,
          orderUnits: plan.purchase ? plan.purchase.quantityUnits : 0,
          blocked: plan.blocked,
        },
        skuId: plan.skuId,
        itemId: plan.itemId,
      })
    );
  }
  return out;
}

/** Meaningful quantity that has not moved outward for a long time. */
function detectStaleInventory(signals) {
  const out = [];
  const t = THRESHOLDS.stale;

  for (const sku of signals.skus) {
    if (!sku.isActive) continue;
    if (sku.measured.onHand < t.minQuantity) continue;

    // Age from the last outbound if there ever was one, otherwise from receipt.
    const idleDays =
      sku.measured.daysSinceLastOutbound !== null
        ? sku.measured.daysSinceLastOutbound
        : sku.measured.lastReceivedAt
          ? daysBetween(sku.measured.lastReceivedAt)
          : null;
    if (idleDays === null || idleDays < t.watchDays) continue;
    if (sku.measured.issuedInWindow > 0) continue; // it is still moving

    out.push(
      candidate({
        category: 'stale_inventory',
        severity: idleDays >= t.importantDays ? 'important' : 'watch',
        confidence: 'high',
        fingerprint: `stale_inventory:${sku.skuId}`,
        title: `${sku.displayName} has not moved`,
        conciseSummary: `${unitCount(sku.measured.onHand, sku.unitLabel)} · no outbound movement in ${dayCount(idleDays)}`,
        explanation:
          `${sku.measured.onHand} are on hand and nothing has been issued for ${dayCount(idleDays)}.` +
          (sku.measured.lastOutboundAt
            ? ` The last issue was on ${sku.measured.lastOutboundAt.slice(0, 10)}.`
            : ' There is no record of any issue for this line.'),
        recommendation: 'Worth reviewing whether this stock is still needed where it is.',
        affectedEntityType: 'sku',
        affectedEntityIds: [sku.skuId],
        affectedLocationIds: sku.perLocation.filter((l) => l.onHand > 0).map((l) => l.locationId),
        evidence: [
          fact('On hand', sku.measured.onHand),
          fact('Days since last issue', Math.round(idleDays)),
          fact('Last issued', sku.measured.lastOutboundAt ? sku.measured.lastOutboundAt.slice(0, 10) : 'never'),
          fact('Last received', sku.measured.lastReceivedAt ? sku.measured.lastReceivedAt.slice(0, 10) : 'unknown'),
        ],
        metrics: {
          onHand: sku.measured.onHand,
          idleDays: round(idleDays, 1),
          issuedInWindow: sku.measured.issuedInWindow,
        },
        skuId: sku.skuId,
        itemId: sku.itemId,
      })
    );
  }
  return out;
}

/**
 * A serialized unit that has sat in one place far longer than the rest.
 *
 * Reported per unit while that is still readable. Past a handful of units of
 * the same product, one card covering them beats a wall of identical ones —
 * a yard with fifty idle machines has one situation, not fifty.
 */
function detectSerializedInactivity(signals) {
  const out = [];
  const t = THRESHOLDS.serialInactivity;

  const idleBySku = new Map();
  for (const unit of signals.serialUnits) {
    const idle = unit.measured.daysSinceLastMovement;
    if (idle === null || idle < t.watchDays) continue;
    if (!idleBySku.has(unit.skuId)) idleBySku.set(unit.skuId, []);
    idleBySku.get(unit.skuId).push({ unit, idle });
  }

  for (const [skuId, group] of idleBySku) {
    if (group.length < t.rollUpAt) continue;

    const sorted = [...group].sort((a, b) => b.idle - a.idle);
    const longest = sorted[0];
    const locations = [...new Set(sorted.map((g) => g.unit.locationName || 'no location'))];
    const total = sorted.length;

    out.push(
      candidate({
        category: 'serialized_inactivity',
        severity: longest.idle >= t.importantDays ? 'important' : 'watch',
        confidence: 'high',
        fingerprint: `serialized_inactivity:sku:${skuId}`,
        title: `${total} ${longest.unit.displayName} units have not moved`,
        conciseSummary:
          `Idle ${Math.round(sorted[total - 1].idle)}–${Math.round(longest.idle)} days · ` +
          locations.slice(0, 3).join(', '),
        explanation:
          `${total} units of ${longest.unit.displayName} have not moved for at least ` +
          `${Math.round(sorted[total - 1].idle)} days. The longest, ${longest.unit.serial}, ` +
          `has been at ${longest.unit.locationName || 'the same place'} for ${Math.round(longest.idle)} days.`,
        recommendation: 'Worth confirming these units are where they should be and still in use.',
        affectedEntityType: 'serial_unit',
        affectedEntityIds: sorted.map((g) => g.unit.unitId),
        affectedLocationIds: [...new Set(sorted.map((g) => g.unit.locationId).filter(Boolean))],
        evidence: [
          fact('Units not moving', total),
          fact('Longest idle', `${longest.unit.serial} · ${Math.round(longest.idle)} days`),
          fact('Shortest idle', `${sorted[total - 1].unit.serial} · ${Math.round(sorted[total - 1].idle)} days`),
          fact('Locations', locations.join(', ')),
          ...sorted.slice(0, 8).map((g) =>
            fact(g.unit.serial, `${g.unit.locationName || 'no location'} · ${Math.round(g.idle)} days · ${g.unit.condition}`)
          ),
        ],
        metrics: { unitCount: total, idleDays: longest.idle, skuId },
        skuId,
        itemId: longest.unit.itemId,
      })
    );
  }

  for (const [skuId, group] of idleBySku) {
    if (group.length >= t.rollUpAt) continue;
    for (const { unit, idle } of group) {
      out.push(
        candidate({
          category: 'serialized_inactivity',
          severity: idle >= t.importantDays ? 'important' : 'watch',
          confidence: 'high',
          fingerprint: `serialized_inactivity:${unit.unitId}`,
          title: `${unit.serial} has not moved in ${dayCount(idle)}`,
          conciseSummary: `${unit.displayName} · ${unit.locationName || 'no location'} · ${unit.condition}`,
          explanation:
            `This unit has been at ${unit.locationName || 'the same place'} since ` +
            `${unit.measured.lastMovementAt ? unit.measured.lastMovementAt.slice(0, 10) : 'it was received'}, ` +
            `${Math.round(idle)} days ago, and its condition is recorded as ${unit.condition}.`,
          recommendation: 'Worth confirming this unit is where it should be and still in use.',
          affectedEntityType: 'serial_unit',
          affectedEntityIds: [unit.unitId],
          affectedLocationIds: unit.locationId ? [unit.locationId] : [],
          evidence: [
            fact('Serial number', unit.serial),
            fact('Location', unit.locationName || 'none'),
            fact('Condition', unit.condition),
            fact('Days since last movement', Math.round(idle)),
          ],
          metrics: { unitId: unit.unitId, idleDays: idle },
          skuId: unit.skuId,
          itemId: unit.itemId,
        })
      );
    }
  }
  return out;
}

/**
 * Records worth a human look even though the Mission 1 invariants hold. This
 * never contradicts the engine — it reports what the engine's own integrity
 * check says, plus records that are legal but odd.
 */
function detectDataIntegrity(signals, { integrity }) {
  const out = [];

  if (integrity && !integrity.ok) {
    out.push(
      candidate({
        category: 'data_integrity',
        severity: 'critical',
        confidence: 'high',
        fingerprint: 'data_integrity:ledger',
        title: 'Inventory records need review',
        conciseSummary: `${integrity.problems.length} discrepancy between balances and movement history`,
        explanation:
          'Foundry re-derived every balance from the movement ledger and found values that do not agree. ' +
          'This does not change what the ledger records; it means something needs investigating.',
        recommendation: 'Review the affected records in Settings before relying on these numbers.',
        affectedEntityType: 'workspace',
        affectedEntityIds: [],
        affectedLocationIds: [],
        evidence: integrity.problems.slice(0, 6).map((p) => fact(p.kind, p.detail)),
        metrics: { problemCount: integrity.problems.length },
      })
    );
  }

  // Stock sitting at a location that has been archived is legal but stranded.
  for (const sku of signals.skus) {
    const stranded = sku.perLocation.filter((l) => l.onHand > 0 && l.locationArchived);
    for (const location of stranded) {
      out.push(
        candidate({
          category: 'data_integrity',
          severity: 'important',
          confidence: 'high',
          fingerprint: `data_integrity:stranded:${sku.skuId}:${location.locationId}`,
          title: `${sku.displayName} is held at an archived location`,
          conciseSummary: `${location.onHand} at ${location.locationName}`,
          explanation:
            `${location.onHand} are recorded at ${location.locationName}, which is archived. ` +
            'The balance is correct, but this stock is easy to forget.',
          recommendation: 'Move this stock to an active location or restore the location.',
          affectedEntityType: 'sku',
          affectedEntityIds: [sku.skuId],
          affectedLocationIds: [location.locationId],
          evidence: [fact('On hand', location.onHand), fact('Location', `${location.locationName} (archived)`)],
          metrics: { onHand: location.onHand },
          skuId: sku.skuId,
          itemId: sku.itemId,
        })
      );
    }
  }

  return out;
}

/**
 * A purchase order past its expected date with stock still outstanding.
 *
 * The care here is in what is *not* said. Foundry does not know whether the
 * supplier is at fault, whether the date was ever agreed, or whether the van is
 * outside — it knows a date has passed and units have not arrived. So the
 * finding states exactly that, and only for orders whose expected date came
 * from a stated lead time or a person, never from Foundry's own assumption.
 */
function detectLatePurchaseOrders(signals) {
  const orders = (signals.purchasing && signals.purchasing.lateOrders) || [];
  const t = THRESHOLDS.latePurchaseOrder;
  const out = [];

  for (const po of orders) {
    if (po.daysLate < t.watchDays) continue;
    if (po.outstandingUnits <= 0) continue;

    const severity =
      po.daysLate >= t.criticalDays ? 'critical' : po.daysLate >= t.importantDays ? 'important' : 'watch';
    const what = po.lines
      .slice(0, 3)
      .map((line) => `${line.outstanding} ${line.displayName}`)
      .join(', ');

    out.push(
      candidate({
        category: 'late_purchase_order',
        severity,
        confidence: 'high',
        fingerprint: `late_purchase_order:${po.poId}`,
        title: `${po.poNumber} is ${dayCount(po.daysLate)} past its expected arrival`,
        conciseSummary: `${po.supplierName} · ${po.outstandingUnits} unit(s) outstanding${po.partiallyReceived ? ' · part of it arrived' : ''}`,
        explanation:
          `${po.poNumber} from ${po.supplierName} was expected on ${po.expectedDate} and still has ` +
          `${po.outstandingUnits} unit(s) outstanding${what ? `: ${what}` : ''}.` +
          (po.partiallyReceived ? ' Part of this order has already been received.' : ''),
        recommendation: 'Worth chasing, or updating the expected date if it has moved.',
        affectedEntityType: 'sku',
        affectedEntityIds: po.lines.map((line) => line.skuId),
        affectedLocationIds: [],
        evidence: [
          fact('Purchase order', po.poNumber),
          fact('Supplier', po.supplierName),
          fact('Expected', po.expectedDate,
            po.expectedDateSource === 'manual' ? 'entered by hand' : "from the supplier's lead time"),
          fact('Days late', po.daysLate),
          fact('Outstanding', po.outstandingUnits),
          ...po.lines.slice(0, 5).map((line) => fact(line.displayName, `${line.outstanding} outstanding`)),
        ],
        metrics: {
          purchaseOrderId: po.poId,
          poNumber: po.poNumber,
          daysLate: po.daysLate,
          outstandingUnits: po.outstandingUnits,
        },
        skuId: po.lines.length ? po.lines[0].skuId : null,
        itemId: null,
      })
    );
  }
  return out;
}

/**
 * What a product costs has moved between one order and the next.
 *
 * Reported as a fact, not a verdict. Prices move for ordinary reasons, and
 * Foundry has no way to tell a negotiated increase from an overcharge — so it
 * shows both figures and suggests a look, and never uses words like "wrong".
 * An increase and a decrease are both worth knowing.
 */
function detectSupplierPriceChanges(signals) {
  const changes = (signals.purchasing && signals.purchasing.priceChanges) || [];
  const t = THRESHOLDS.priceChange;
  const out = [];

  for (const change of changes) {
    if (change.previous.unitCost < t.minPreviousCost) continue;
    const magnitude = Math.abs(change.percent);
    if (magnitude < t.minPercent) continue;

    const rose = change.delta > 0;
    const severity = magnitude >= t.importantPercent && rose ? 'important' : 'watch';

    out.push(
      candidate({
        category: 'supplier_price_change',
        severity,
        confidence: 'high',
        // Keyed on the two orders being compared, so the finding stays put
        // until the next order gives something new to compare.
        fingerprint: `supplier_price_change:${change.skuId}:${change.current.poId}`,
        title: `${change.displayName} ${rose ? 'costs more' : 'costs less'} than last order`,
        conciseSummary:
          `${change.previous.unitCost} → ${change.current.unitCost} per ${change.unitLabel} ` +
          `(${rose ? '+' : ''}${change.percent}%)`,
        explanation:
          `${change.displayName} was ${change.previous.unitCost} per ${change.unitLabel} on ` +
          `${change.previous.poNumber} and is ${change.current.unitCost} on ${change.current.poNumber}, ` +
          `${rose ? 'up' : 'down'} ${Math.abs(change.percent)}%.` +
          (change.sameSupplier
            ? ''
            : ` These are different suppliers — ${change.previous.supplierName} then ${change.current.supplierName}.`),
        recommendation: 'Worth a look before the next order.',
        affectedEntityType: 'sku',
        affectedEntityIds: [change.skuId],
        affectedLocationIds: [],
        evidence: [
          fact('Previous', `${change.previous.unitCost} on ${change.previous.poNumber}`, change.previous.supplierName),
          fact('Current', `${change.current.unitCost} on ${change.current.poNumber}`, change.current.supplierName),
          fact('Change', `${rose ? '+' : ''}${change.delta} per ${change.unitLabel}`),
          fact('Percent', `${rose ? '+' : ''}${change.percent}%`),
        ],
        metrics: {
          skuId: change.skuId,
          previousCost: change.previous.unitCost,
          currentCost: change.current.unitCost,
          percent: change.percent,
        },
        skuId: change.skuId,
        itemId: null,
      })
    );
  }
  return out;
}

const DETECTORS = {
  replenishment_needed: detectReplenishment,
  low_stock: detectLowStock,
  stockout_risk: detectStockoutRisk,
  late_purchase_order: detectLatePurchaseOrders,
  supplier_price_change: detectSupplierPriceChanges,
  location_imbalance: detectLocationImbalance,
  unusual_adjustment: detectUnusualAdjustment,
  expiring_inventory: detectExpiringInventory,
  stale_inventory: detectStaleInventory,
  serialized_inactivity: detectSerializedInactivity,
  data_integrity: detectDataIntegrity,
};

module.exports = {
  unitCount,
  DETECTORS,
  detectReplenishment,
  detectLowStock,
  detectStockoutRisk,
  detectLatePurchaseOrders,
  detectSupplierPriceChanges,
  incomingFor,
  incomingText,
  detectLocationImbalance,
  detectUnusualAdjustment,
  detectExpiringInventory,
  detectStaleInventory,
  detectSerializedInactivity,
  detectDataIntegrity,
};
