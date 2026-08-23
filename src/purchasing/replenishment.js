'use strict';

/**
 * What should I order, how much, and why?
 *
 * Every number produced here is arithmetic over facts: balances from Mission 1,
 * usage from the Mission 3 signal engine, outstanding quantities from real
 * purchase orders, and the supplier's own stated pack size, minimum and lead
 * time. No model is consulted at this layer and none may be — a recommendation
 * to spend money has to be reproducible and arguable, and "the AI said 72" is
 * neither.
 *
 * The method is the ordinary reorder-point one, chosen because it can be
 * explained in two sentences to someone who has never heard of it:
 *
 *   reorder point = what you use while waiting for a delivery + a safety margin
 *   order up to   = the reorder point + a period of normal cover
 *   order         = (order up to) − (what you have) − (what is already coming)
 *
 * It is not a forecast. It assumes recent usage continues, and says so. Nothing
 * here claims to predict demand, seasonality or trend; where the evidence is
 * too thin to support even this, it declines to recommend rather than guessing.
 *
 * The single most important behaviour: **on-order quantity counts**. Asking
 * "what should I order?" three times in a morning must not produce three
 * orders, and an item with enough already inbound must produce a clear "no,
 * you are covered" — which is as useful an answer as a purchase.
 */

const signalEngine = require('../signals/signal-engine');
const position = require('./position');
const supplierService = require('./supplier-service');
const policyService = require('./policy-service');

/**
 * Constants of the method, in one place so a recommendation can name the rule
 * it applied rather than presenting a magic number.
 */
const DEFAULTS = {
  // How long a delivery is assumed to take when nobody has said. Deliberately
  // conservative, and always reported as an assumption rather than a fact.
  leadTimeDays: 14,
  // Cover bought beyond the reorder point, when no target stock is configured.
  coverDays: 30,
  // Safety margin, when none is configured: a week of normal usage.
  safetyDays: 7,
  // How often someone is assumed to look at this. Usage during that window has
  // to be covered too, or a line is short before the next review comes round.
  reviewPeriodDays: 7,
  // Usage is measured over this many days of history.
  usageWindowDays: 30,
};

const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

function fact(label, value, note) {
  return { label, value: value === null || value === undefined ? '—' : value, note: note || null };
}

/**
 * Works out one line's recommendation.
 *
 * @returns {object} always — "order nothing" is a result, not an absence of one.
 */
function evaluateSku(db, workspaceId, sku, options = {}) {
  const now = options.now || Date.now();
  const policy = options.policy || policyService.effectivePolicy(db, workspaceId, sku.skuId);
  const incoming = options.incoming || position.onOrderForSku(db, workspaceId, sku.skuId);
  const candidates = options.suppliers || supplierService.suppliersForSku(db, workspaceId, sku.skuId);

  const onHand = sku.measured.onHand;
  const onOrder = incoming.onOrder;
  const inventoryPosition = onHand + onOrder;

  const usage = sku.estimated.hasUsageEvidence ? sku.estimated.averageDailyUsage : null;
  const usageWindow = sku.measured.windowDays;
  const issued = sku.measured.issuedInWindow;

  const chosen = chooseSupplier(candidates, {
    daysOfStockRemaining: sku.estimated.daysOfStockRemaining,
    preferredSupplierId: policy.preferredSupplierId,
  });
  const supplierItem = chosen.supplierItem;

  // Lead time, in order of authority: an explicit policy, then what this
  // supplier says for this product, then the supplier's general figure, then a
  // stated assumption.
  const leadTime =
    policy.leadTimeDays ??
    (supplierItem ? supplierItem.effectiveLeadTimeDays : null) ??
    null;
  const leadTimeDays = leadTime ?? DEFAULTS.leadTimeDays;
  const leadTimeAssumed = leadTime === null;

  const base = {
    skuId: sku.skuId,
    itemId: sku.itemId,
    displayName: sku.displayName,
    unitLabel: sku.unitLabel,
    onHand,
    onOrder,
    position: inventoryPosition,
    incoming,
    usagePerDay: usage,
    issuedInWindow: issued,
    usageWindowDays: usageWindow,
    daysOfStockRemaining: sku.estimated.daysOfStockRemaining,
    leadTimeDays,
    leadTimeAssumed,
    policy,
    supplier: supplierItem
      ? {
          supplierItemId: supplierItem.id,
          supplierId: supplierItem.supplierId,
          supplierName: supplierItem.supplierName,
          purchaseUnit: supplierItem.purchaseUnit,
          unitsPerPurchaseUnit: supplierItem.unitsPerPurchaseUnit,
          unitCost: supplierItem.lastUnitCost,
          leadTimeDays: supplierItem.effectiveLeadTimeDays,
          minimumOrderQuantity: supplierItem.minimumOrderQuantity,
          orderMultiple: supplierItem.orderMultiple,
        }
      : null,
    supplierChoice: chosen,
    alternatives: candidates.filter((c) => !supplierItem || c.id !== supplierItem.id),
    now,
  };

  // --- can a recommendation be made at all? ---------------------------------

  if (!usage && policy.reorderPoint === null) {
    return {
      ...base,
      recommend: false,
      reason: 'no_usage_evidence',
      headline: 'Not enough history to recommend a quantity',
      explanation:
        `Foundry has ${issued} issued in the last ${usageWindow} days, which is not enough to ` +
        'estimate usage. Set a reorder point for this line and it will watch that instead.',
      evidence: [
        fact('On hand', onHand),
        fact('On order', onOrder),
        fact(`Issued in last ${usageWindow} days`, issued),
        fact('Reorder point', 'not set'),
      ],
      calculation: [],
    };
  }

  // --- the reorder point ----------------------------------------------------

  const steps = [];
  const usagePerDay = usage || 0;

  let safetyStock;
  if (policy.safetyStock !== null) {
    safetyStock = policy.safetyStock;
    steps.push({ step: 'safety', detail: `Safety stock is set to ${safetyStock}.`, value: safetyStock });
  } else {
    safetyStock = Math.ceil(usagePerDay * DEFAULTS.safetyDays);
    steps.push({
      step: 'safety',
      detail: `Safety margin of ${DEFAULTS.safetyDays} days: ${round(usagePerDay, 2)}/day × ${DEFAULTS.safetyDays} = ${safetyStock}.`,
      value: safetyStock,
    });
  }

  let reorderPoint;
  if (policy.reorderPoint !== null) {
    reorderPoint = policy.reorderPoint;
    steps.push({ step: 'reorder_point', detail: `Reorder point is set to ${reorderPoint}.`, value: reorderPoint });
  } else {
    const duringLead = Math.ceil(usagePerDay * (leadTimeDays + DEFAULTS.reviewPeriodDays));
    reorderPoint = duringLead + safetyStock;
    steps.push({
      step: 'reorder_point',
      detail:
        `Usage while waiting: ${round(usagePerDay, 2)}/day × (${leadTimeDays} days lead time + ` +
        `${DEFAULTS.reviewPeriodDays} days until the next review) = ${duringLead}, plus ${safetyStock} safety = ${reorderPoint}.`,
      value: reorderPoint,
    });
  }

  let target;
  if (policy.targetStock !== null) {
    target = policy.targetStock;
    steps.push({ step: 'target', detail: `Target stock level is set to ${target}.`, value: target });
  } else {
    const cover = Math.ceil(usagePerDay * DEFAULTS.coverDays);
    target = reorderPoint + cover;
    steps.push({
      step: 'target',
      detail: `Order up to the reorder point plus ${DEFAULTS.coverDays} days of cover (${cover}) = ${target}.`,
      value: target,
    });
  }

  // --- do we need anything? -------------------------------------------------

  steps.push({
    step: 'position',
    detail:
      onOrder > 0
        ? `Position is ${onHand} on hand + ${onOrder} already on order = ${inventoryPosition}.`
        : `Position is ${onHand} on hand, with nothing on order.`,
    value: inventoryPosition,
  });

  if (inventoryPosition > reorderPoint) {
    const coverDays = usagePerDay > 0 ? round(inventoryPosition / usagePerDay, 1) : null;
    return {
      ...base,
      recommend: false,
      reason: onOrder > 0 ? 'covered_by_incoming' : 'above_reorder_point',
      reorderPoint,
      target,
      safetyStock,
      headline: 'No additional order',
      explanation:
        onOrder > 0
          ? `${onHand} on hand and ${onOrder} already on order comes to ${inventoryPosition}, ` +
            `above the reorder point of ${reorderPoint}. Incoming stock currently covers the expected requirement` +
            `${coverDays ? `, about ${coverDays} days at recent usage` : ''}.`
          : `${onHand} on hand is above the reorder point of ${reorderPoint}` +
            `${coverDays ? `, about ${coverDays} days at recent usage` : ''}.`,
      evidence: evidenceFor(base, { reorderPoint, target, safetyStock, usagePerDay }),
      calculation: steps,
    };
  }

  // --- how much? ------------------------------------------------------------

  const shortfall = Math.max(0, target - inventoryPosition);
  steps.push({
    step: 'shortfall',
    detail: `Order up to ${target} − position ${inventoryPosition} = ${shortfall} ${sku.unitLabel}(s) needed.`,
    value: shortfall,
  });

  if (shortfall <= 0) {
    return {
      ...base,
      recommend: false,
      reason: 'nothing_needed',
      reorderPoint,
      target,
      safetyStock,
      headline: 'No additional order',
      explanation: `Position of ${inventoryPosition} already meets the target of ${target}.`,
      evidence: evidenceFor(base, { reorderPoint, target, safetyStock, usagePerDay }),
      calculation: steps,
    };
  }

  // An order already drafted is a decision taken and waiting on a signature.
  //
  // It is not counted as on-order, because nobody has told the supplier
  // anything and the stock is not coming. But recommending it again is how the
  // same shortfall gets ordered twice — once from the Purchasing page and once
  // from wherever else the recommendation is shown.
  const drafted = options.drafted || position.draftedForSku(db, workspaceId, sku.skuId);
  if (drafted.units >= shortfall) {
    steps.push({
      step: 'already_prepared',
      detail:
        `${drafted.units} ${sku.unitLabel}(s) are already prepared on ` +
        `${drafted.orders.map((o) => o.poNumber).join(', ')}, which covers the ${shortfall} needed.`,
      value: 0,
    });
    return {
      ...base,
      recommend: false,
      reason: 'already_prepared',
      reorderPoint,
      target,
      safetyStock,
      shortfall,
      prepared: drafted,
      headline: 'Already prepared',
      explanation:
        `This line is ${shortfall} short of its target, and ${drafted.units} ` +
        `${sku.unitLabel}(s) are already drafted on ` +
        `${drafted.orders.map((o) => o.poNumber).join(', ')}. Approve that rather than ordering again.`,
      evidence: evidenceFor(base, { reorderPoint, target, safetyStock, usagePerDay, shortfall }),
      calculation: steps,
    };
  }

  if (!supplierItem) {
    return {
      ...base,
      recommend: false,
      reason: 'no_supplier',
      reorderPoint,
      target,
      safetyStock,
      shortfall,
      headline: `${shortfall} short, but no supplier on file`,
      explanation:
        `This line is below its reorder point and about ${shortfall} short of target, but no supplier ` +
        'is linked to it, so Foundry cannot work out a pack size, a cost or a lead time. Add one and it will.',
      evidence: evidenceFor(base, { reorderPoint, target, safetyStock, usagePerDay }),
      calculation: steps,
    };
  }

  // The supplier's own rules decide the final quantity.
  const converted = supplierService.toPurchaseUnits(shortfall, supplierItem);
  for (const step of converted.steps) steps.push(step);

  const defaultQuantity = policy.defaultOrderQuantity;
  let finalUnits = converted.units;
  let finalPurchaseUnits = converted.purchaseUnits;
  if (defaultQuantity && defaultQuantity > 0) {
    const asPacks = supplierService.toPurchaseUnits(defaultQuantity, supplierItem);
    if (asPacks.units > finalUnits) {
      steps.push({
        step: 'default_quantity',
        detail: `This line has a default order quantity of ${defaultQuantity}, which is larger.`,
        value: asPacks.units,
      });
      finalUnits = asPacks.units;
      finalPurchaseUnits = asPacks.purchaseUnits;
    }
  }

  const unitCost = supplierItem.lastUnitCost;
  const estimatedCost = unitCost !== null && unitCost !== undefined ? round(unitCost * finalUnits, 2) : null;
  const daysUntilOut = usagePerDay > 0 ? round(onHand / usagePerDay, 1) : null;
  const arrivesInTime =
    daysUntilOut === null || incoming.nextExpectedDate === null ? null : daysUntilOut > leadTimeDays;

  return {
    ...base,
    recommend: true,
    reason: 'below_reorder_point',
    reorderPoint,
    target,
    safetyStock,
    shortfall,
    quantityUnits: finalUnits,
    quantityPurchaseUnits: finalPurchaseUnits,
    purchaseUnit: supplierItem.purchaseUnit,
    unitsPerPurchaseUnit: supplierItem.unitsPerPurchaseUnit,
    unitCost,
    estimatedCost,
    headline:
      finalPurchaseUnits === finalUnits
        ? `Order ${finalUnits} ${sku.unitLabel}(s)`
        : `Order ${finalUnits} ${sku.unitLabel}(s) — ${finalPurchaseUnits} ${supplierItem.purchaseUnit}(s)`,
    explanation:
      `${onHand} on hand${onOrder ? ` and ${onOrder} on order` : ''} is at or below the reorder point of ` +
      `${reorderPoint}. At recent usage of ${round(usagePerDay, 2)} a day, ` +
      `${daysUntilOut !== null ? `stock lasts about ${daysUntilOut} days` : 'stock is running down'}, ` +
      `and a delivery takes ${leadTimeDays} days${leadTimeAssumed ? ' (assumed — no lead time on file)' : ''}.`,
    urgency: daysUntilOut !== null && daysUntilOut < leadTimeDays ? 'may_run_out_first' : 'normal',
    arrivesInTime,
    evidence: evidenceFor(base, {
      reorderPoint,
      target,
      safetyStock,
      usagePerDay,
      shortfall,
      finalUnits,
      finalPurchaseUnits,
      supplierItem,
      estimatedCost,
    }),
    calculation: steps,
  };
}

/** Every input that went into the recommendation, in the order it was used. */
function evidenceFor(base, extra) {
  const supplierItem = extra.supplierItem || (base.supplier ? base.supplier : null);
  const rows = [
    fact('On hand', base.onHand),
    fact('On order', base.onOrder, base.incoming.nextExpectedDate ? `next expected ${base.incoming.nextExpectedDate}` : null),
    fact('Inventory position', base.position, 'on hand + on order'),
    fact(
      `Issued in last ${base.usageWindowDays} days`,
      base.issuedInWindow,
      base.usagePerDay ? `about ${round(base.usagePerDay, 2)} a day` : 'not enough to estimate a rate'
    ),
    fact(
      'Lead time',
      `${base.leadTimeDays} days`,
      base.leadTimeAssumed ? 'assumed — no lead time on file' : null
    ),
    fact('Safety stock', extra.safetyStock, base.policy.safetyStock === null ? 'derived from usage' : 'configured'),
    fact('Reorder point', extra.reorderPoint, base.policy.reorderPoint === null ? 'derived from usage and lead time' : 'configured'),
    fact('Order up to', extra.target, base.policy.targetStock === null ? 'derived' : 'configured'),
  ];

  if (extra.shortfall !== undefined) rows.push(fact('Shortfall', extra.shortfall));
  if (supplierItem) {
    rows.push(
      fact('Supplier', supplierItem.supplierName),
      fact(
        'Purchase unit',
        supplierItem.unitsPerPurchaseUnit > 1
          ? `${supplierItem.purchaseUnit} of ${supplierItem.unitsPerPurchaseUnit}`
          : supplierItem.purchaseUnit
      )
    );
    if (supplierItem.minimumOrderQuantity) {
      rows.push(fact('Minimum order', `${supplierItem.minimumOrderQuantity} ${supplierItem.purchaseUnit}(s)`));
    }
    if (supplierItem.orderMultiple && supplierItem.orderMultiple > 1) {
      rows.push(fact('Order multiple', `${supplierItem.orderMultiple} ${supplierItem.purchaseUnit}(s)`));
    }
    const cost = supplierItem.lastUnitCost ?? supplierItem.unitCost;
    if (cost !== null && cost !== undefined) rows.push(fact('Last unit cost', cost));
  }
  if (extra.finalUnits !== undefined) {
    rows.push(
      fact(
        'Recommended',
        extra.finalPurchaseUnits === extra.finalUnits
          ? `${extra.finalUnits}`
          : `${extra.finalUnits} (${extra.finalPurchaseUnits} × ${supplierItem.unitsPerPurchaseUnit})`
      )
    );
    if (extra.estimatedCost !== null && extra.estimatedCost !== undefined) {
      rows.push(fact('Estimated cost', extra.estimatedCost));
    }
  }
  return rows;
}

/**
 * Which supplier to buy this from.
 *
 * Only structured facts are compared: whether one is marked preferred, what it
 * costs, and how long it takes. There is no reliability score, because Foundry
 * has no evidence for one — it has never measured whether a supplier delivers
 * on time across enough orders to say anything honest about it.
 *
 * Speed only outranks price when stock would otherwise run out first, and when
 * it does, the trade is stated in money rather than asserted.
 */
function chooseSupplier(candidates, { daysOfStockRemaining = null, preferredSupplierId = null } = {}) {
  const usable = candidates.filter((c) => c.isActive !== false);
  if (usable.length === 0) return { supplierItem: null, because: 'no supplier is linked to this product' };
  if (usable.length === 1) {
    return { supplierItem: usable[0], because: `${usable[0].supplierName} is the only supplier on file` };
  }

  const byPolicy = preferredSupplierId ? usable.find((c) => c.supplierId === preferredSupplierId) : null;
  if (byPolicy) {
    return { supplierItem: byPolicy, because: `${byPolicy.supplierName} is set as the preferred supplier for this line` };
  }

  const flagged = usable.find((c) => c.isPreferred);
  const cheapest = [...usable]
    .filter((c) => c.lastUnitCost !== null && c.lastUnitCost !== undefined)
    .sort((a, b) => a.lastUnitCost - b.lastUnitCost)[0];
  const fastest = [...usable]
    .filter((c) => c.effectiveLeadTimeDays !== null && c.effectiveLeadTimeDays !== undefined)
    .sort((a, b) => a.effectiveLeadTimeDays - b.effectiveLeadTimeDays)[0];

  // Running out before the cheaper option could arrive is the one case where
  // paying more is the better answer, and it is explained in full.
  if (
    daysOfStockRemaining !== null &&
    cheapest &&
    fastest &&
    cheapest.id !== fastest.id &&
    cheapest.effectiveLeadTimeDays !== null &&
    daysOfStockRemaining < cheapest.effectiveLeadTimeDays &&
    daysOfStockRemaining >= fastest.effectiveLeadTimeDays
  ) {
    const extra =
      cheapest.lastUnitCost !== null && fastest.lastUnitCost !== null
        ? round(fastest.lastUnitCost - cheapest.lastUnitCost, 2)
        : null;
    return {
      supplierItem: fastest,
      because:
        `${fastest.supplierName} takes ${fastest.effectiveLeadTimeDays} days against ` +
        `${cheapest.supplierName}'s ${cheapest.effectiveLeadTimeDays}, and there is about ` +
        `${round(daysOfStockRemaining, 1)} days of stock left` +
        (extra !== null && extra > 0
          ? `. It costs ${extra} more per unit, but is likely to arrive before current stock is exhausted.`
          : '.'),
      alternative: cheapest,
      tradeOff: extra,
    };
  }

  if (flagged) return { supplierItem: flagged, because: `${flagged.supplierName} is marked as the preferred supplier` };
  if (cheapest) {
    return {
      supplierItem: cheapest,
      because:
        cheapest.lastUnitCost !== null
          ? `${cheapest.supplierName} is the cheapest on file at ${cheapest.lastUnitCost} per unit`
          : `${cheapest.supplierName} is the first supplier on file`,
    };
  }
  return { supplierItem: usable[0], because: `${usable[0].supplierName} is the first supplier on file` };
}

/**
 * Every line in the workspace, evaluated.
 *
 * @returns {{recommendations, covered, blocked, bySupplier, evaluatedAt}}
 */
function evaluateWorkspace(db, workspaceId, options = {}) {
  const now = options.now || Date.now();
  const skus = signalEngine.skuSignals(db, workspaceId, {
    skuIds: options.skuIds || null,
    now,
    windowDays: options.usageWindowDays || DEFAULTS.usageWindowDays,
  });

  const active = skus.filter((sku) => sku.isActive);
  const incomingBySku = position.onOrderBySku(db, workspaceId, {
    skuIds: active.map((s) => s.skuId),
    now,
  });
  const policies = policyService.policiesBySku(db, workspaceId);

  const results = active.map((sku) =>
    evaluateSku(db, workspaceId, sku, {
      now,
      incoming: incomingBySku.get(sku.skuId) || {
        onOrder: 0,
        lines: [],
        orders: [],
        nextExpectedDate: null,
        overdueUnits: 0,
      },
      policy: policies.get(sku.skuId) || policyService.emptyPolicy(sku.skuId),
    })
  );

  const recommendations = results
    .filter((r) => r.recommend)
    .sort((a, b) => {
      // Most urgent first: the ones that run out before a delivery could land.
      const rank = (r) => (r.urgency === 'may_run_out_first' ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      const aDays = a.daysOfStockRemaining ?? Number.MAX_SAFE_INTEGER;
      const bDays = b.daysOfStockRemaining ?? Number.MAX_SAFE_INTEGER;
      return aDays - bDays;
    });

  // Grouped the way the work is actually done: one order per supplier.
  const bySupplier = new Map();
  for (const line of recommendations) {
    if (!line.supplier) continue;
    if (!bySupplier.has(line.supplier.supplierId)) {
      bySupplier.set(line.supplier.supplierId, {
        supplierId: line.supplier.supplierId,
        supplierName: line.supplier.supplierName,
        lines: [],
        estimatedTotal: 0,
        hasUnpricedLines: false,
      });
    }
    const group = bySupplier.get(line.supplier.supplierId);
    group.lines.push(line);
    if (line.estimatedCost === null) group.hasUnpricedLines = true;
    else group.estimatedTotal = round(group.estimatedTotal + line.estimatedCost, 2);
  }

  return {
    evaluatedAt: new Date(now).toISOString(),
    recommendations,
    covered: results.filter((r) => !r.recommend && ['covered_by_incoming', 'above_reorder_point', 'nothing_needed'].includes(r.reason)),
    blocked: results.filter((r) => !r.recommend && ['no_supplier', 'no_usage_evidence'].includes(r.reason)),
    all: results,
    bySupplier: [...bySupplier.values()].sort((a, b) => b.lines.length - a.lines.length),
    method: DEFAULTS,
  };
}

/** One line, by SKU id — for "why are you recommending 48?". */
function evaluateOne(db, workspaceId, skuId, options = {}) {
  const now = options.now || Date.now();
  const [sku] = signalEngine.skuSignals(db, workspaceId, {
    skuIds: [skuId],
    now,
    windowDays: options.usageWindowDays || DEFAULTS.usageWindowDays,
  });
  if (!sku) return null;
  return evaluateSku(db, workspaceId, sku, { now });
}

module.exports = {
  DEFAULTS,
  evaluateSku,
  evaluateOne,
  evaluateWorkspace,
  chooseSupplier,
  evidenceFor,
  round,
};
