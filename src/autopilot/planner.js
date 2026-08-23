'use strict';

/**
 * Working out what inventory work should happen now.
 *
 * Entirely deterministic: balances from Mission 1, usage from the Mission 3
 * signal engine, incoming from Mission 6 purchase orders. A model may later
 * describe or group what is planned here, but it may not add to it — inventing
 * work is how an automaton becomes busy rather than useful.
 *
 * "Nothing needs doing" is a legitimate and common answer, and the planner says
 * it plainly rather than manufacturing something to justify its existence.
 */

const signalEngine = require('../signals/signal-engine');
const repo = require('../domain/repository');
const position = require('../purchasing/position');
const replenishment = require('../purchasing/replenishment');
const replenishmentPlan = require('../purchasing/replenishment-plan');
const policyService = require('./policy-service');
const preferences = require('./preferences');
const workItems = require('./work-items');

/**
 * How the balancing signal is judged.
 *
 * These are the numbers behind "likely to run out": a location is at risk when
 * its own outflow would empty it before stock could reasonably arrive, and a
 * location can spare stock only when it keeps a comfortable margin of its own.
 */
const BALANCE = {
  // A destination with fewer than this many days of its own cover is at risk.
  riskDays: 14,
  // A source must keep at least this many days of its own cover after giving.
  sourceSafetyDays: 30,
  // What the destination is topped up to. Bringing it only to the risk line
  // would leave it still at the risk line, and it would be back tomorrow — so
  // it is brought to the same cover the source is required to keep.
  targetDays: 30,
  // Below this there is not enough history for the rate to mean anything.
  minIssueEvents: 2,
  minIssued: 3,
  // Never propose moving less than this; a trickle is not worth a movement.
  minQuantity: 2,
};

const round = (value, places = 1) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Per-location demand for one SKU.
 *
 * The workspace-level rate is useless here — the whole point is that one
 * warehouse is selling and the other is not.
 */
function locationDemand(sku) {
  return sku.perLocation.map((location) => {
    const issued = location.issuedInWindow;
    const days = sku.measured.observedDays || sku.measured.windowDays;
    const rate = days > 0 && issued > 0 ? issued / days : 0;
    return {
      locationId: location.locationId,
      locationName: location.locationName,
      onHand: location.onHand,
      issued,
      ratePerDay: round(rate, 3),
      daysOfCover: rate > 0 ? round(location.onHand / rate, 1) : null,
    };
  });
}

/**
 * A transfer that would relieve a shortage in one location from surplus in
 * another, or nothing.
 *
 * Returns the evidence alongside the numbers, because every one of these has to
 * survive being read back to a customer months later.
 */
/**
 * Replenishment plans, or none.
 *
 * Wrapped because a workspace with no purchasing configured must not lose its
 * whole autopilot run to a planner that had nothing to read.
 */
function safePlans(db, workspaceId, skus, now) {
  try {
    return replenishmentPlan.planWorkspace(db, workspaceId, { skus }, { now });
  } catch {
    return { plans: [], governed: [], governedSkuIds: new Set(), actionable: [], combined: [], combinedSkuIds: new Set() };
  }
}

function planBalanceTransfer(db, workspaceId, sku, options = {}) {
  const maximum = options.maximumQuantity || null;
  const incoming = options.incoming || { onOrder: 0 };
  // The customer's stated numbers where they have stated any, Foundry's
  // otherwise. Never inferred — see autopilot/preferences.
  const settings = options.settings || preferences.balanceSettings(db, workspaceId, BALANCE);

  // Item 23: not enough history is a real answer, and saying it beats going
  // quiet. `decline` carries the reason so the operator can be told why this
  // product is not being handled automatically instead of wondering.
  const decline = (reason, detail) => {
    if (options.reasons) options.reasons.push({ skuId: sku.skuId, displayName: sku.displayName, reason, detail });
    return null;
  };

  if (settings.neverAutomateSerialized && sku.trackingMode === 'serial') {
    return decline(
      'serialised',
      'You asked Foundry not to move serialised items automatically.'
    );
  }

  if (sku.measured.issueEventsInWindow < BALANCE.minIssueEvents || sku.measured.issuedInWindow < BALANCE.minIssued) {
    return decline(
      'not_enough_history',
      `${sku.displayName} has ${sku.measured.issueEventsInWindow} movements in the last ` +
        `${sku.measured.windowDays} days. Foundry does not have enough history to automate this safely yet.`
    );
  }

  const locations = locationDemand(sku).filter((location) => !location.locationArchived);
  if (locations.length < 2) return null;

  // At risk: running down, with less cover than a delivery would take.
  const atRisk = locations
    .filter((location) => location.ratePerDay > 0 && location.daysOfCover !== null)
    .filter((location) => location.daysOfCover < settings.riskDays)
    .sort((a, b) => a.daysOfCover - b.daysOfCover)[0];
  if (!atRisk) return null;

  // Already covered by stock on its way: not a transfer problem.
  if (incoming.onOrder > 0 && atRisk.ratePerDay > 0) {
    const coveredDays = (atRisk.onHand + incoming.onOrder) / atRisk.ratePerDay;
    if (coveredDays >= settings.riskDays) return null;
  }

  const source = locations
    .filter((location) => location.locationId !== atRisk.locationId && location.onHand > 0)
    .map((location) => {
      // What it can give while keeping its own safety cover.
      const keep = location.ratePerDay > 0 ? Math.ceil(location.ratePerDay * settings.sourceSafetyDays) : 0;
      return { ...location, keep, canSpare: Math.max(0, location.onHand - keep) };
    })
    .filter((location) => location.canSpare >= BALANCE.minQuantity)
    .sort((a, b) => b.canSpare - a.canSpare)[0];
  if (!source) return null;

  // Bring the destination up to a sensible cover, within what the source can
  // spare and whatever ceiling the policy imposes.
  const wanted = Math.max(
    BALANCE.minQuantity,
    Math.ceil(atRisk.ratePerDay * settings.targetDays) - atRisk.onHand
  );
  let quantity = Math.min(wanted, source.canSpare);
  if (maximum) quantity = Math.min(quantity, maximum);
  if (quantity < BALANCE.minQuantity) return null;

  return {
    skuId: sku.skuId,
    itemId: sku.itemId,
    displayName: sku.displayName,
    quantity,
    fromLocationId: source.locationId,
    fromLocationName: source.locationName,
    toLocationId: atRisk.locationId,
    toLocationName: atRisk.locationName,
    // Everything the policy engine needs to judge its named conditions, each
    // with the measurement that settled it.
    conditions: {
      [policyService.CONDITIONS.DESTINATION_STOCKOUT_RISK]: {
        passed: true,
        detail: `${atRisk.locationName} has ${atRisk.onHand} left and issued ${atRisk.issued} in ${sku.measured.windowDays} days — about ${atRisk.daysOfCover} days of cover.`,
      },
      [policyService.CONDITIONS.SOURCE_ABOVE_SAFETY]: {
        passed: source.onHand - quantity >= source.keep,
        detail: `${source.locationName} keeps ${source.onHand - quantity} after this, above the ${source.keep} it needs for ${settings.sourceSafetyDays} days.`,
      },
      [policyService.CONDITIONS.SUFFICIENT_HISTORY]: {
        passed: true,
        detail: `${sku.measured.issueEventsInWindow} movements over ${round(sku.measured.observedDays)} days.`,
      },
      [policyService.CONDITIONS.NO_CONFLICTING_TRANSFER]: {
        passed: !options.hasOpenTransfer,
        detail: options.hasOpenTransfer ? 'another transfer of this product is already waiting' : 'nothing else in flight',
      },
    },
    evidence: [
      { label: `${atRisk.locationName} on hand`, value: atRisk.onHand },
      { label: `${atRisk.locationName} issued (${sku.measured.windowDays} days)`, value: atRisk.issued },
      { label: `${atRisk.locationName} days of cover`, value: atRisk.daysOfCover },
      { label: `${source.locationName} on hand`, value: source.onHand },
      { label: `${source.locationName} issued (${sku.measured.windowDays} days)`, value: source.issued },
      { label: `${source.locationName} keeps back`, value: source.keep },
      { label: 'On order', value: incoming.onOrder },
    ],
  };
}

/**
 * Everything worth doing in this workspace right now.
 *
 * @returns {{ transfers, purchases, conflicts, nothingToDo }}
 */
function plan(db, workspaceId, options = {}) {
  const now = options.now || Date.now();
  const skus = signalEngine.skuSignals(db, workspaceId, { now }).filter((sku) => sku.isActive);
  const incoming = position.onOrderBySku(db, workspaceId, { now });

  // The tightest ceiling any approved transfer policy imposes, so a plan is
  // never larger than anything could authorise.
  const transferPolicies = policyService.activeFor(db, workspaceId, 'transfer');
  const ceiling = transferPolicies.length
    ? Math.min(...transferPolicies.map((policy) => policy.maximumQuantity || Infinity))
    : null;

  const open = new Set(
    workItems
      .list(db, workspaceId, {
        status: [workItems.STATUS.PLANNED, workItems.STATUS.WAITING_FOR_APPROVAL, workItems.STATUS.AUTHORIZED, workItems.STATUS.EXECUTING],
        category: 'balance_transfer',
        limit: 200,
      })
      // A piece of work sized before the ceiling existed — or before it was
      // lowered — can never be carried out, and left in the way it would block
      // this shortage for the rest of the day. Nothing has happened to it yet,
      // so it is re-planned rather than treated as in hand.
      .filter((item) => {
        if (!Number.isFinite(ceiling)) return true;
        const stale =
          item.executionStatus === workItems.STATUS.WAITING_FOR_APPROVAL &&
          !item.approvedAt &&
          Number((item.recommendedAction || {}).quantity) > ceiling;
        return !stale;
      })
      .map((item) => item.affectedEntities.skuId)
      .filter(Boolean)
  );

  const transfers = [];
  const conflicts = [];
  // Why particular products are not being handled automatically. Collected so
  // the answer to "why isn't Foundry doing this one?" is a sentence rather
  // than silence.
  const declined = [];
  const settings = preferences.balanceSettings(db, workspaceId, BALANCE);

  // One decision per stock need.
  //
  // A line with a configured reorder point is the replenishment planner's, and
  // it decides the move and the order together. Letting the two independent
  // paths below also speak for those lines is what put "Move 45 to Downtown"
  // and "PO-1002 is ready to send" in front of the same person as two separate
  // approvals, with nothing tying them together and no shared arithmetic — the
  // move drained the warehouse to zero on the assumption the order was not
  // happening, and the order was sized on the assumption the move was not.
  const replenishmentPlans = safePlans(db, workspaceId, skus, now);
  // Two different exclusions, because the two paths fail differently.
  //
  // Moves: a line with a configured reorder point belongs to the replenishment
  // planner outright. The older balance heuristic reasons only about days of
  // cover and knows nothing about the level, the order-up-to or the order — it
  // proposed emptying a warehouse of 45 into a shop the planner had already
  // measured as adequately stocked. Two engines proposing movements for one
  // product is the fragmentation itself.
  //
  // Orders: only withheld when the plan also has a move, because then the two
  // must be decided together. A line needing nothing but an order has nothing
  // to be fragmented against, and leaving it on the ordinary purchasing path
  // keeps the authority Foundry already has to prepare it under an approved
  // policy.
  const governedMoves = replenishmentPlans.governedSkuIds;
  const governedOrders = replenishmentPlans.combinedSkuIds;

  for (const sku of skus) {
    const engine = require('./policy-engine');
    const conflict = engine.detectConflicts(db, workspaceId, sku.skuId, { totalOnHand: sku.measured.onHand });
    if (conflict) {
      conflicts.push(conflict);
      continue;                       // never plan a move while the rules argue
    }
    if (governedMoves.has(sku.skuId)) continue;   // the plan speaks for this one

    const proposal = planBalanceTransfer(db, workspaceId, sku, {
      maximumQuantity: ceiling && Number.isFinite(ceiling) ? ceiling : null,
      incoming: incoming.get(sku.skuId) || { onOrder: 0 },
      hasOpenTransfer: open.has(sku.skuId),
      settings,
      reasons: declined,
    });
    if (proposal) transfers.push(proposal);
  }

  // Purchasing: Mission 6 already decides what to buy and why. The planner's
  // job is only to notice that it wants something and turn that into work.
  let purchases = [];
  try {
    const replenish = replenishment.evaluateWorkspace(db, workspaceId, { now });
    purchases = replenish.bySupplier
      // Governed lines are bought as part of their own plan, beside the move
      // that goes with them. A supplier group emptied of every line is dropped.
      .map((group) => ({ ...group, lines: group.lines.filter((line) => !governedOrders.has(line.skuId)) }))
      .filter((group) => group.lines.length)
      .map((group) => ({
      supplierId: group.supplierId,
      supplierName: group.supplierName,
      lines: group.lines.map((line) => ({
        skuId: line.skuId,
        displayName: line.displayName,
        quantityPurchaseUnits: line.quantityPurchaseUnits,
        quantityUnits: line.quantityUnits,
        unitCost: line.unitCost,
        evidence: line.evidence,
      })),
      estimatedTotal: group.estimatedTotal,
    }));
  } catch {
    purchases = [];                   // an inventory with no purchasing set up
  }

  // Deliveries that have arrived at their date, or gone past it. Foundry cannot
  // receive them — that is a person checking what is physically in the box, and
  // no packing-list feed exists to check it against — but leaving a delivery to
  // be noticed is exactly the routine work this is meant to take off them.
  const receiving = [
    ...position.arrivingSoon(db, workspaceId, { days: 1, now }).map((po) => ({ po, late: false })),
    ...position.lateOrders(db, workspaceId, { now }).map((po) => ({ po, late: true })),
  ]
    // A late order is already in the list once; do not raise it twice.
    .filter((entry, index, all) => all.findIndex((other) => other.po.id === entry.po.id) === index)
    .map(({ po, late }) => ({
      purchaseOrderId: po.id,
      poNumber: po.po_number,
      supplierName: po.supplier_name,
      expectedDate: po.expected_date,
      outstandingUnits: po.outstanding_units,
      late,
      daysLate: late ? po.daysLate : 0,
    }));

  return {
    transfers,
    purchases,
    // Each is one coherent answer: where the stock should move, what should be
    // bought, and the arithmetic that says both are needed at once.
    replenishmentPlans: replenishmentPlans.combined,
    receiving,
    conflicts,
    declined,
    settings,
    nothingToDo:
      transfers.length === 0 && purchases.length === 0 && receiving.length === 0 && conflicts.length === 0,
    evaluatedAt: new Date(now).toISOString(),
  };
}

module.exports = {
  BALANCE,
  locationDemand,
  planBalanceTransfer,
  plan,
};
