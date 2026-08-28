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
const modes = require('./modes');
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
      committed: Number(location.committed || 0),
      available: Number.isFinite(Number(location.available)) ? Number(location.available) : location.onHand,
      issued,
      ratePerDay: round(rate, 3),
      daysOfCover: rate > 0 ? round((Number.isFinite(Number(location.available)) ? Number(location.available) : location.onHand) / rate, 1) : null,
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
  const statedLocationRules = require('../purchasing/policy-service').locationPolicies(db, workspaceId, sku.skuId);
  const ruleByLocation = new Map(statedLocationRules.map((rule) => [rule.locationId, rule]));

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

  // A stated location threshold wins over a derived days-of-cover threshold.
  // It is still only a trigger/target: authority, source safety, evidence and
  // verification remain exactly the same deterministic gates below.
  const explicitRisk = locations
    .filter((location) => {
      const rule = ruleByLocation.get(location.locationId);
      return rule && Number.isFinite(Number(rule.minimum)) && location.available < Number(rule.minimum);
    })
    .sort((a, b) => a.onHand - b.onHand)[0];
  const atRisk = explicitRisk || locations
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
    .filter((location) => location.locationId !== atRisk.locationId && location.available > 0)
    .map((location) => {
      // What it can give while keeping its own safety cover.
      const statedMinimum = Number(ruleByLocation.get(location.locationId)?.minimum) || 0;
      const keep = Math.max(statedMinimum,
        location.ratePerDay > 0 ? Math.ceil(location.ratePerDay * settings.sourceSafetyDays) : 0);
      return { ...location, keep, canSpare: Math.max(0, location.available - keep) };
    })
    .filter((location) => location.canSpare >= BALANCE.minQuantity)
    .sort((a, b) => b.canSpare - a.canSpare)[0];
  if (!source) return null;

  // Bring the destination up to a sensible cover, within what the source can
  // spare. `maximumQuantity` is only for callers revalidating an already-sized
  // action; authority limits must never resize a newly discovered need. The
  // policy engine has to see the full required quantity so it can refuse work
  // outside the approved boundary and put that exception in Needs you.
  const rawTarget = ruleByLocation.get(atRisk.locationId)?.target;
  const statedTarget = rawTarget === null || rawTarget === undefined ? null : Number(rawTarget);
  const wanted = Math.max(
    BALANCE.minQuantity,
    (statedTarget !== null && Number.isFinite(statedTarget) && statedTarget >= 0
      ? statedTarget
      : Math.ceil(atRisk.ratePerDay * settings.targetDays)) - atRisk.available
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
        detail: explicitRisk
          ? `${atRisk.locationName} has ${atRisk.onHand}, below the owner-set location threshold of ${ruleByLocation.get(atRisk.locationId).minimum}.`
          : `${atRisk.locationName} has ${atRisk.onHand} left and issued ${atRisk.issued} in ${sku.measured.windowDays} days — about ${atRisk.daysOfCover} days of cover.`,
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
  // Whether Foundry may act on its own decides which work reaches a person.
  const state = modes.ensure(db, workspaceId);
  const scopedSkuIds = options.scope && Array.isArray(options.scope.skuIds)
    ? options.scope.skuIds.filter(Boolean) : null;
  const skus = signalEngine.skuSignals(db, workspaceId, {
    now,
    ...(scopedSkuIds && scopedSkuIds.length ? { skuIds: scopedSkuIds } : {}),
  }).filter((sku) => sku.isActive);
  const incoming = position.onOrderBySku(db, workspaceId, { now });

  const open = new Set(
    workItems
      .list(db, workspaceId, {
        status: [workItems.STATUS.PLANNED, workItems.STATUS.WAITING_FOR_APPROVAL, workItems.STATUS.AUTHORIZED, workItems.STATUS.EXECUTING],
        category: 'balance_transfer',
        limit: 200,
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
  // A configured line's replenishment is one decision, and the plan is it.
  //
  // Moves were already the planner's: the older balance heuristic reasons only
  // about days of cover, knows nothing about the level or the order, and
  // proposed emptying a warehouse of 45 into a shop the planner had measured as
  // adequately stocked.
  //
  // Orders were left on the ordinary purchasing path whenever a line needed
  // nothing else, on the reasoning that a single action cannot be fragmented.
  // That was wrong from the customer's side. On a fresh workspace it meant the
  // first thing they ever saw was "PO-1001 is ready to send", opening onto a
  // page that says only that the order is prepared — being asked to approve the
  // consequence without ever seeing the replenishment decision that caused it.
  //
  // The one exception is work that never reaches a person at all: an order an
  // approved policy will place by itself, on a line needing no movement. There
  // is no decision to fragment there, and routing it through a plan would take
  // away authority the customer explicitly granted.
  const handledByPolicy = (plan) =>
    plan.transfers.length === 0
    && Boolean(plan.purchase)
    && state.mode === 'POLICY_AUTOMATED'
    && policyService
      .list(db, workspaceId, { activeOnly: true })
      .some((policy) =>
        policy.allowedActionTypes.includes('approve_purchase_order')
        && (!policy.supplierScope.length || policy.supplierScope.includes(plan.purchase.supplierId)));

  // "No supplier" is setup missing, not an action to approve. The attention
  // item points straight to supplier setup; a work item here would offer an
  // approval that cannot move or order anything.
  const userFacing = replenishmentPlans.actionable
    .filter((plan) => !plan.blocked)
    .filter((plan) => !handledByPolicy(plan));
  const governedMoves = replenishmentPlans.governedSkuIds;
  const governedOrders = new Set(userFacing.map((plan) => plan.skuId));

  for (const sku of skus) {
    const engine = require('./policy-engine');
    const conflict = engine.detectConflicts(db, workspaceId, sku.skuId, { totalOnHand: sku.measured.onHand });
    if (conflict) {
      conflicts.push(conflict);
      continue;                       // never plan a move while the rules argue
    }
    if (governedMoves.has(sku.skuId)) continue;   // the plan speaks for this one

    const proposal = planBalanceTransfer(db, workspaceId, sku, {
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
    // Upcoming deliveries belong on the horizon. They become human work only
    // on their expected date; before then there is no physical arrival to book.
    ...position.arrivingSoon(db, workspaceId, { days: 0, now }).map((po) => ({ po, late: false })),
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
    replenishmentPlans: userFacing,
    receiving,
    conflicts,
    declined,
    settings,
    // A prepared replenishment plan is emphatically something to do. Left out
    // of this count, "order what we need" answered "no purchase is currently
    // supported" while the plan it had just prepared sat on the home page.
    nothingToDo:
      transfers.length === 0 && purchases.length === 0 && receiving.length === 0
      && conflicts.length === 0 && userFacing.length === 0,
    evaluatedAt: new Date(now).toISOString(),
  };
}

module.exports = {
  BALANCE,
  locationDemand,
  planBalanceTransfer,
  plan,
};
