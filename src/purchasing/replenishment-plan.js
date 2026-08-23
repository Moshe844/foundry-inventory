'use strict';

/**
 * One replenishment answer for one product, covering every location at once.
 *
 * Foundry used to answer this question twice, in two places that could not see
 * each other. The attention engine compared locations and suggested a transfer;
 * the purchasing engine compared the total against a reorder point and
 * suggested an order. Both were individually defensible and together they were
 * nonsense — "move all 45 warehouse units downtown" beside "order 36 from the
 * supplier" is not a plan, it is two opinions, and the person reading them has
 * to work out for themselves whether the second is still true after the first.
 *
 * That reconciliation is arithmetic, so Foundry does it.
 *
 * The inputs are considered in a fixed order, because each one narrows what the
 * next may conclude:
 *
 *   1. on hand, by location           — where the stock physically is
 *   2. outbound evidence, by location — where it is actually being used
 *   3. reorder point and order-up-to  — the level the business asked for
 *   4. already on order               — what is coming without doing anything
 *   5. stock at other locations       — what could move instead of being bought
 *   6. reserve / keep-back rules      — what may not move, whatever the need
 *   7. supplier purchase rules        — pack size, minimum, lead time
 *
 * The property that keeps a transfer and an order consistent is that they
 * answer different questions. A transfer changes *where* stock is and never
 * changes how much of it exists: the network position — everything on hand
 * anywhere, plus everything on order — is identical before and after. So the
 * order quantity is computed from the network position alone, and is unaffected
 * by any transfer in the same plan. Both can appear together precisely because
 * neither can move the other's number.
 *
 * No model is consulted here and none may be. Every figure below is arithmetic
 * over recorded facts, and each is emitted with the sentence that produced it,
 * so a plan can be argued with rather than believed.
 */

const policyService = require('./policy-service');
const position = require('./position');
const autopilotPolicies = require('../autopilot/policy-service');
const replenishment = require('./replenishment');

/** Days of its own demand a location keeps for itself before any is spare. */
const LOCAL_COVER_DAYS = 14;

const round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const sum = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0);

function step(key, detail, value) {
  return { step: key, detail, value: value === undefined ? null : value };
}

/**
 * Floors a location keeps regardless of demand elsewhere.
 *
 * These come from the autopilot policies the customer wrote, which is the only
 * place the product lets anyone say "this shop always keeps ten". A floor is a
 * refusal rather than a preference: stock below it is not available to move,
 * even when another location is empty.
 */
function reserveFloors(db, workspaceId) {
  const floors = new Map();
  let active = [];
  try {
    active = autopilotPolicies.list(db, workspaceId, { activeOnly: true }) || [];
  } catch (error) {
    return floors; // no policy engine in play is the same as no floors
  }
  for (const policy of active) {
    const minimums = policy.thresholds && policy.thresholds.minimumByLocation;
    if (!minimums) continue;
    for (const [locationId, minimum] of Object.entries(minimums)) {
      const value = Number(minimum) || 0;
      // Two rules covering one location: the stricter wins, neither is ignored.
      if (value > (floors.get(locationId) || 0)) floors.set(locationId, value);
    }
  }
  return floors;
}

/**
 * What each location needs to hold on its own account.
 *
 * A location's claim on stock is its own demand, not an even share: a shop
 * selling nine a fortnight has a larger claim than one selling one, and a
 * location with no outbound at all has no demand-based claim whatever — only
 * its reserve floor, if it has one.
 */
function locationNeeds(sku, target, floors) {
  const windowDays = Math.max(sku.measured.windowDays || 30, 1);
  const totalOutbound = sum(sku.perLocation, (l) => l.outboundInWindow);

  return sku.perLocation.map((loc) => {
    const floor = floors.get(loc.locationId) || 0;
    const dailyUse = loc.outboundInWindow / windowDays;
    // Its own demand over the cover period, capped by the network target: one
    // location cannot claim more than the whole product is stocked to hold.
    const fromDemand = Math.min(Math.ceil(dailyUse * LOCAL_COVER_DAYS), Math.max(target, 0));
    return {
      locationId: loc.locationId,
      locationName: loc.locationName,
      onHand: loc.onHand,
      outboundInWindow: loc.outboundInWindow,
      dailyUse: round(dailyUse, 3),
      demandShare: totalOutbound > 0 ? round(loc.outboundInWindow / totalOutbound, 3) : 0,
      reserveFloor: floor,
      need: Math.max(floor, fromDemand),
    };
  });
}

/**
 * Moves that reduce a real shortage using stock that is genuinely spare.
 *
 * Spare means above both the source's own need and its reserve floor. A
 * transfer that empties one shop to fill another has not solved anything: it
 * has moved the problem, and spent the handling to do it. Largest surplus to
 * largest deficit, so the fewest moves do the most good.
 */
function planTransfers(needs, unitLabel) {
  const spare = new Map();
  const donors = [];
  for (const loc of needs) {
    const available = Math.max(0, loc.onHand - loc.need);
    if (available <= 0) continue;
    spare.set(loc.locationId, available);
    donors.push({ ...loc, spare: available });
  }
  donors.sort((a, b) => b.spare - a.spare);

  const short = needs
    .map((loc) => ({ ...loc, deficit: Math.max(0, loc.need - loc.onHand) }))
    .filter((loc) => loc.deficit > 0)
    .sort((a, b) => b.deficit - a.deficit);

  const moves = [];
  const steps = [];
  if (!donors.length || !short.length) return { moves, steps };

  for (const target of short) {
    let stillShort = target.deficit;
    for (const donor of donors) {
      if (stillShort <= 0) break;
      if (donor.locationId === target.locationId) continue;
      const available = spare.get(donor.locationId) || 0;
      if (available <= 0) continue;

      const quantity = Math.min(available, stillShort);
      spare.set(donor.locationId, available - quantity);
      stillShort -= quantity;

      moves.push({
        fromLocationId: donor.locationId,
        fromLocationName: donor.locationName,
        toLocationId: target.locationId,
        toLocationName: target.locationName,
        quantity,
        why:
          `${target.locationName} needs ${target.need} and holds ${target.onHand}. ` +
          `${donor.locationName} holds ${donor.onHand} against a need of ${donor.need}` +
          `${donor.reserveFloor ? ` (including a reserve of ${donor.reserveFloor})` : ''}, ` +
          `so ${donor.spare} ${unitLabel}(s) there are spare.`,
      });
      steps.push(
        step(
          'transfer',
          `Move ${quantity} from ${donor.locationName} to ${target.locationName}: ` +
            `${target.locationName} is ${target.deficit} short, and ${donor.locationName} holds ` +
            `${donor.spare} above its own need.`,
          quantity
        )
      );
    }
  }
  return { moves, steps };
}

/** What each location holds once the transfers, and any delivery, have landed. */
function projectAfter(needs, moves, purchase) {
  const byId = new Map(needs.map((loc) => [loc.locationId, { ...loc, after: loc.onHand }]));
  for (const move of moves) {
    byId.get(move.fromLocationId).after -= move.quantity;
    byId.get(move.toLocationId).after += move.quantity;
  }
  const rows = [...byId.values()].map((loc) => ({
    locationId: loc.locationId,
    locationName: loc.locationName,
    before: loc.onHand,
    after: loc.after,
    need: loc.need,
    reserveFloor: loc.reserveFloor,
    meetsNeed: loc.after >= loc.need,
  }));
  const onHandAfterMoves = sum(rows, (r) => r.after);
  return {
    byLocation: rows,
    onHandAfterMoves,
    onHandAfterDelivery: onHandAfterMoves + (purchase ? purchase.quantityUnits : 0),
  };
}

/**
 * The whole answer for one product.
 *
 * @returns {object} always — "nothing to do" is a plan, and is stated as one.
 */
function buildPlan(db, workspaceId, sku, options = {}) {
  const now = options.now || Date.now();
  const policy = options.policy || policyService.effectivePolicy(db, workspaceId, sku.skuId);
  const incoming = options.incoming || position.onOrderForSku(db, workspaceId, sku.skuId);
  const floors = options.reserveFloors || reserveFloors(db, workspaceId);
  const unitLabel = sku.unitLabel || 'unit';

  // The purchasing engine already turns evidence and policy into a reorder
  // point, an order-up-to level and a supplier quantity. It is reused rather
  // than reimplemented: two answers to "how much should we buy" is the failure
  // this module exists to remove, and a second one here would recreate it a
  // layer down.
  const buy = replenishment.evaluateSku(db, workspaceId, sku, { now, policy, incoming });

  const steps = [];
  const onHandTotal = sku.measured.onHand;
  const onOrder = incoming.onOrder;
  const networkPosition = onHandTotal + onOrder;

  steps.push(
    step(
      'on_hand',
      sku.perLocation.length
        ? `On hand: ${sku.perLocation.map((l) => `${l.onHand} at ${l.locationName}`).join(', ')} — ${onHandTotal} in total.`
        : `On hand: ${onHandTotal}.`,
      onHandTotal
    )
  );
  steps.push(
    step(
      'demand',
      sku.estimated.hasUsageEvidence
        ? `Outbound in the last ${sku.measured.windowDays} days: ${sku.measured.issuedInWindow}, about ` +
          `${round(sku.estimated.averageDailyUsage, 2)} a day.`
        : `No outbound movement recorded in the last ${sku.measured.windowDays} days.`,
      sku.measured.issuedInWindow
    )
  );

  const reorderPoint = buy.reorderPoint ?? null;
  const target = buy.target ?? null;

  // Without a level there is nothing to be below, and a transfer proposed on
  // demand alone is exactly the uncoordinated advice this module replaces.
  if (reorderPoint === null || target === null) {
    return {
      skuId: sku.skuId,
      itemId: sku.itemId,
      displayName: sku.displayName,
      unitLabel,
      decision: 'none',
      reason: buy.reason,
      configured: false,
      belowReorderPoint: false,
      headline: buy.headline,
      explanation: buy.explanation,
      onHandTotal,
      onOrder,
      networkPosition,
      reorderPoint: null,
      target: null,
      safetyStock: null,
      byLocation: locationNeeds(sku, 0, floors),
      transfers: [],
      purchase: null,
      blocked: null,
      after: null,
      calculation: steps.concat(buy.calculation || []),
      evidence: buy.evidence || [],
      now,
    };
  }

  steps.push(step('reorder_point', `Reorder point is ${reorderPoint}; order up to ${target}.`, reorderPoint));
  steps.push(
    step(
      'on_order',
      onOrder > 0
        ? `Already on order: ${onOrder}${incoming.nextExpectedDate ? `, next expected ${incoming.nextExpectedDate}` : ''}.`
        : 'Nothing is on order.',
      onOrder
    )
  );
  steps.push(
    step(
      'position',
      `Position across every location is ${onHandTotal} on hand + ${onOrder} on order = ${networkPosition}.`,
      networkPosition
    )
  );

  const needs = locationNeeds(sku, target, floors);
  for (const loc of needs) {
    if (loc.reserveFloor > 0) {
      steps.push(
        step(
          'reserve',
          `${loc.locationName} keeps a reserve of ${loc.reserveFloor}, so only stock above that may move.`,
          loc.reserveFloor
        )
      );
    }
  }

  const { moves, steps: transferSteps } = planTransfers(needs, unitLabel);
  for (const one of transferSteps) steps.push(one);
  if (!moves.length) {
    steps.push(step('transfer', 'No location holds stock another needs more, so nothing moves.', 0));
  }

  // The order quantity comes from the network position, which no transfer
  // changes. This is what stops the two halves of a plan contradicting.
  const belowPoint = networkPosition <= reorderPoint;
  const purchase = buy.recommend
    ? {
        supplierId: buy.supplier.supplierId,
        supplierName: buy.supplier.supplierName,
        quantityUnits: buy.quantityUnits,
        quantityPurchaseUnits: buy.quantityPurchaseUnits,
        purchaseUnit: buy.purchaseUnit,
        unitsPerPurchaseUnit: buy.unitsPerPurchaseUnit,
        unitCost: buy.unitCost,
        estimatedCost: buy.estimatedCost,
        leadTimeDays: buy.leadTimeDays,
        leadTimeAssumed: buy.leadTimeAssumed,
        shortfall: buy.shortfall,
      }
    : null;

  // An order already drafted suppresses another for the same shortfall. The
  // purchasing engine owns that rule, so it is read here rather than repeated:
  // two copies of "have we already decided this?" is how they come to disagree.
  const prepared = buy.prepared || null;
  if (prepared) {
    steps.push(
      step(
        'purchase',
        `Nothing more to order: ${prepared.units} ${unitLabel}(s) are already prepared on ` +
          `${prepared.orders.map((o) => o.poNumber).join(', ')}, waiting to be approved.`,
        0
      )
    );
  }

  if (purchase) {
    steps.push(
      step(
        'purchase',
        `Order up to ${target} − position ${networkPosition} = ${buy.shortfall} needed. ` +
          `${purchase.supplierName} supplies these ` +
          `${purchase.unitsPerPurchaseUnit === 1 ? 'singly' : `in ${purchase.purchaseUnit}s of ${purchase.unitsPerPurchaseUnit}`}, ` +
          `so ${purchase.quantityPurchaseUnits} ${purchase.purchaseUnit}(s) = ${purchase.quantityUnits} ${unitLabel}(s).`,
        purchase.quantityUnits
      )
    );
    if (moves.length) {
      steps.push(
        step(
          'independence',
          'Moving stock between locations does not change how much of it exists, so this order ' +
            'quantity is the same with or without the transfers above.',
          purchase.quantityUnits
        )
      );
    }
  } else if (prepared) {
    // already said above
  } else if (belowPoint) {
    steps.push(step('purchase', `Nothing is ordered: ${buy.headline.toLowerCase()}.`, 0));
  } else {
    steps.push(
      step(
        'purchase',
        `Position of ${networkPosition} is above the reorder point of ${reorderPoint}, so nothing is ordered.`,
        0
      )
    );
  }

  const decision =
    moves.length && purchase
      ? 'transfer_and_purchase'
      : moves.length
        ? 'transfer'
        : purchase
          ? 'purchase'
          : 'none';

  const after = projectAfter(needs, moves, purchase);
  const moved = sum(moves, (m) => m.quantity);

  // Built by branch rather than by lookup: a lookup table evaluates every arm,
  // and three of these read a purchase that is null whenever none is proposed.
  let headline;
  let explanation;
  if (decision === 'transfer_and_purchase') {
    headline = `Move ${moved} ${unitLabel}(s) and order ${purchase.quantityUnits}`;
    explanation =
      `${onHandTotal} on hand${onOrder ? ` and ${onOrder} on order` : ''} comes to ${networkPosition}, at or below ` +
      `the reorder point of ${reorderPoint} — so this is both in the wrong place and short overall. The transfer ` +
      'fixes where it is; the order fixes how much there is. Neither changes the other’s number.';
  } else if (decision === 'transfer') {
    headline = `Move ${moved} ${unitLabel}(s) between locations`;
    explanation =
      `There is enough overall — ${networkPosition} against a reorder point of ${reorderPoint} — but it is not ` +
      'where the demand is. Moving it is enough, and nothing needs to be bought.';
  } else if (decision === 'purchase') {
    headline = buy.headline;
    explanation = buy.explanation;
  } else {
    headline = belowPoint ? buy.headline : 'Nothing needed';
    explanation = belowPoint
      ? buy.explanation
      : `Position of ${networkPosition} is above the reorder point of ${reorderPoint}, and every location holds what it needs.`;
  }

  return {
    skuId: sku.skuId,
    itemId: sku.itemId,
    displayName: sku.displayName,
    unitLabel,
    decision,
    reason: buy.reason,
    configured: policy.isSet && policy.reorderPoint !== null,
    belowReorderPoint: belowPoint,
    headline,
    explanation,
    onHandTotal,
    onOrder,
    networkPosition,
    reorderPoint,
    target,
    safetyStock: buy.safetyStock ?? null,
    policySource: policy.source || 'manual',
    byLocation: needs,
    transfers: moves,
    purchase,
    blocked: !purchase && belowPoint && buy.reason === 'no_supplier' ? 'no_supplier' : null,
    prepared,
    after,
    calculation: steps,
    evidence: buy.evidence || [],
    now,
  };
}

/**
 * The single sentence telling someone what this plan asks of them.
 *
 * It lives beside the arithmetic because it is derived from the decision rather
 * than written about it. The finding stores a copy at detection time and the
 * detail page rebuilds a fresh one; both call this, so a card cannot end up
 * offering an order in its heading that its own body has already withdrawn.
 */
function recommendationFor(plan) {
  const moved = sum(plan.transfers, (move) => move.quantity);
  const buying = plan.purchase
    ? `order ${plan.purchase.quantityPurchaseUnits} ${plan.purchase.purchaseUnit}(s) from ${plan.purchase.supplierName}`
    : '';

  if (plan.blocked === 'no_supplier') {
    return 'Add a supplier for this line and Foundry can work out the quantity.';
  }
  if (plan.decision === 'transfer_and_purchase') {
    return `Move ${moved} ${plan.unitLabel}(s) between locations and ${buying}. ` +
      'Review the whole plan before anything happens.';
  }
  if (plan.decision === 'transfer') {
    return plan.prepared
      ? `Move ${moved} ${plan.unitLabel}(s) between locations. The order for this line is already prepared.`
      : `Move ${moved} ${plan.unitLabel}(s) between locations. Nothing needs to be bought.`;
  }
  if (plan.decision === 'purchase' && plan.purchase) {
    return `${buying.charAt(0).toUpperCase()}${buying.slice(1)}.`;
  }
  if (plan.prepared) {
    return 'Approve the order that is already prepared rather than raising another.';
  }
  return 'Review replenishment for this line.';
}


/**
 * Plans for every active line, worked out once.
 *
 * Two sets come back because two questions are being asked. `actionable` is
 * what to show someone. `governed` is every line the planner is responsible
 * for at all — including the ones it decided need nothing — because any other
 * engine tempted to give distribution advice about those lines must defer to
 * the plan, and "the plan said nothing is needed" is still the plan speaking.
 */
function planWorkspace(db, workspaceId, signals, options = {}) {
  const floors = reserveFloors(db, workspaceId);
  const plans = [];
  for (const sku of signals.skus) {
    if (!sku.isActive) continue;
    plans.push(buildPlan(db, workspaceId, sku, { ...options, reserveFloors: floors }));
  }
  // Only lines whose reorder point the customer actually configured.
  //
  // The purchasing engine will happily derive a reorder point from usage when
  // none is set, which is the right behaviour for answering "what should I
  // order?" on demand — but a derived level is not a level the business asked
  // to be told about, and treating it as one would put every moving product in
  // Needs you and silence the ordinary out-of-stock and imbalance findings that
  // cover those lines today. Configured means asked for; asked for means
  // watched.
  const governed = plans.filter((plan) => plan.configured);
  return {
    plans,
    governed,
    governedSkuIds: new Set(governed.map((plan) => plan.skuId)),
    actionable: governed.filter((plan) => plan.decision !== 'none' || plan.blocked),
  };
}

module.exports = {
  recommendationFor,
  LOCAL_COVER_DAYS,
  buildPlan,
  planWorkspace,
  reserveFloors,
  locationNeeds,
  planTransfers,
};
