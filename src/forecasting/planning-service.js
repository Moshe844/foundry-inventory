'use strict';

/**
 * Where are we heading, what will become a problem, and what should be done
 * before it does.
 *
 * Everything under src/forecasting answers one narrow question well. This is
 * the module that asks them in the right order and turns the answers into
 * something an owner can act on in one click, because the failure mode of every
 * planning system ever built is that it produces a beautiful analysis nobody
 * opens. There is no Forecasting tab anybody has to visit every morning; there
 * are recommendations that appear where the work already is.
 *
 * The order of questions matters and is not arbitrary:
 *
 *   1. what will we run out of, and when            projection
 *   2. is anything already coming that fixes it     on-order first, always
 *   3. can we move stock instead of buying it       the cheapest fix there is
 *   4. is the rule that governs this still right    adaptive policy
 *   5. only then: should we buy, how much, when     purchasing
 *
 * Buying is last on purpose. A system that reaches for a purchase order first
 * will buy stock it already owns, buy it twice, and buy it into a warehouse
 * that is already full — and every one of those looks like diligence.
 *
 * "Don't order yet" is a first-class recommendation here and gets the same
 * explanation as "order now". An assistant that only ever speaks up to spend
 * money is not advising anybody.
 */

const { newId, nowIso } = require('../lib/util');
const forecastEngine = require('./forecast');
const leadTimeEngine = require('./lead-time');
const projectionEngine = require('./projection');
const policyAdvice = require('./policy-advice');
const rebalanceEngine = require('./rebalance');
const excessEngine = require('./excess');
const anomalyEngine = require('./anomalies');
const supplierReliability = require('./supplier-reliability');
const goalsService = require('./goals');
const purchasingPolicy = require('../purchasing/policy-service');
const supplierService = require('../purchasing/supplier-service');
const position = require('../purchasing/position');
const demandHistory = require('./demand-history');
const recommendations = require('./recommendations');
const adaptiveBrain = require('./adaptive-brain');

const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const money = (minor, currency = 'USD') =>
  `${currency === 'USD' ? '$' : `${currency} `}${(Number(minor || 0) / 100).toFixed(2)}`;

/*
 * How urgent something has to be before it interrupts somebody. A projection
 * reaching zero in ninety days is true and can wait; one reaching zero before
 * the supplier can possibly deliver is the entire job.
 */
const URGENCY = {
  // Anything running out inside its own lead time cannot be fixed by ordering
  // normally, which is what makes it worth saying now.
  breachesLeadTime: 100,
  // A promise to a customer that the stock cannot keep.
  breaksCommitment: 120,
  // Running out within this many days, even with time to react.
  soonDays: 21,
};

/**
 * The complete picture for one product. Everything else in this file is built
 * from this, and the product page shows it more or less directly.
 */
function forSku(db, workspaceId, skuId, options = {}) {
  const now = options.now || Date.now();
  const goals = options.goals || goalsService.forWorkspace(db, workspaceId);
  const sku = options.sku || describeSku(db, workspaceId, skuId);
  if (!sku) return null;

  const policy = options.policy || purchasingPolicy.effectivePolicy(db, workspaceId, skuId);
  const suppliers = options.suppliers || supplierService.suppliersForSku(db, workspaceId, skuId);
  const supplierItem = chooseSupplierItem(suppliers, policy);

  const leadTime = supplierItem
    ? leadTimeEngine.forSupplier(db, workspaceId, supplierItem.supplierId, {
      now, supplierItem, skuId,
    })
    : { planningDays: policy.leadTimeDays ?? null, source: policy.leadTimeDays ? 'configured' : 'unknown',
      configuredDays: policy.leadTimeDays ?? null, measured: null, material: false,
      differenceDays: null, supplierName: null, supplierId: null, deliveries: [],
      explanation: 'No supplier is linked to this product, so StockChief has no delivery time to plan against.' };

  /*
   * The horizon is the lead time plus the review gap, never a round number.
   * The window that matters is exactly "long enough that ordering today still
   * arrives in time" — a fixed 30 days is too short for a sea freight supplier
   * and pointlessly long for one who delivers tomorrow.
   */
  const planningDays = leadTime.planningDays === null ? 14 : leadTime.planningDays;
  const horizonDays = Math.max(14, Math.ceil(planningDays + (goals.reviewDays || 7)));

  const history = demandHistory.series(db, workspaceId, skuId, {
    now, windowDays: options.windowDays || 180,
  });
  const forecast = forecastEngine.forSku(db, workspaceId, skuId, {
    now, horizonDays, history, holdoutDays: options.holdoutDays,
  });
  const projection = projectionEngine.project(db, workspaceId, skuId, {
    now, forecast, horizonDays: Math.max(horizonDays, 60), leadTimeDays: planningDays,
  });
  const advice = policyAdvice.advise({ forecast, leadTime, policy, goals, displayName: sku.displayName });
  const transfers = rebalanceEngine.forSku(db, workspaceId, skuId, { now, goals });
  const purchase = decidePurchase({
    db, workspaceId, sku, forecast, leadTime, projection, advice, policy,
    suppliers, supplierItem, goals, transfers, now,
  });
  const adaptivePlan = adaptiveBrain.forSku(db, workspaceId, {
    sku, goals, policy, forecast, leadTime, projection, advice, suppliers,
    supplierItem, transfers, purchase, horizonDays,
  }, { now, workspaceContext: options.workspaceContext });

  return {
    sku, goals, policy, forecast, leadTime, projection, advice, purchase, adaptivePlan,
    transfers: transfers.transfers,
    locations: transfers.places,
    supplierItem,
    anomalies: skuAnomalies({ db, workspaceId, sku, history, projection, leadTime }),
    horizonDays,
  };
}

function describeSku(db, workspaceId, skuId) {
  const row = db.prepare(`SELECT s.id, s.code, s.variant_label, s.item_id, i.name AS item_name,
      i.unit_label, i.tracking_mode
    FROM skus s JOIN items i ON i.id = s.item_id
    WHERE s.workspace_id = ? AND s.id = ?`).get(workspaceId, skuId);
  if (!row) return null;
  return {
    skuId: row.id, itemId: row.item_id, code: row.code,
    displayName: row.variant_label ? `${row.item_name} / ${row.variant_label}` : row.item_name,
    unitLabel: row.unit_label || 'unit', trackingMode: row.tracking_mode,
  };
}

function chooseSupplierItem(suppliers, policy) {
  if (!suppliers || !suppliers.length) return null;
  if (policy && policy.preferredSupplierId) {
    const preferred = suppliers.find((row) => row.supplierId === policy.preferredSupplierId);
    if (preferred) return preferred;
  }
  return suppliers.find((row) => row.isPreferred) || suppliers[0];
}

/**
 * Order now, order later, or don't order.
 *
 * The quantity comes from the target the *owner* configured where one exists,
 * and from the recommended target only where none does. Ordering to a number
 * StockChief made up, on a line whose rule the owner set deliberately, would be
 * overriding them without saying so — the recommendation to change the rule is
 * a separate conversation with its own buttons.
 */
function decidePurchase({ db, workspaceId, sku, forecast, leadTime, projection, advice, policy, suppliers, supplierItem, goals, transfers, now }) {
  const drafted = position.draftedForSku(db, workspaceId, sku.skuId);
  const currency = supplierItem && supplierItem.currency ? supplierItem.currency : 'USD';

  const base = {
    skuId: sku.skuId,
    displayName: sku.displayName,
    onHand: projection.onHand,
    onOrder: projection.onOrder,
    committed: projection.committedUnits,
    stockoutDate: projection.stockoutDate,
    daysUntilStockout: projection.daysUntilStockout,
    leadTimeDays: leadTime.planningDays,
    confidence: forecast.confidence,
    confidenceLabel: forecast.confidenceLabel,
    currency,
  };

  // Already drafted: a decision taken and waiting on a signature.
  if (drafted.units > 0) {
    return { ...base, order: false, reason: 'already_prepared',
      headline: 'Already prepared',
      explanation: `${drafted.units} are already drafted on `
        + `${drafted.orders.map((order) => order.poNumber).join(', ')}. Approve that rather than ordering again.` };
  }

  // Nothing is going to go wrong inside the window we can see.
  if (!projection.stockoutDate) {
    const cover = projection.dailyRate && projection.dailyRate > 0
      ? Math.round(projection.onHand / projection.dailyRate) : null;
    return { ...base, order: false, reason: 'covered',
      headline: 'Nothing to order yet',
      explanation: forecast.dailyRate === null
        ? `${projection.onHand} in stock and no customer order outstanding. StockChief cannot estimate a `
          + 'sales rate for this yet, so it is not recommending a purchase on a guess.'
        : `${projection.onHand} in stock at about ${forecast.dailyRate} a day`
          + `${projection.onOrder ? `, with ${projection.onOrder} already on order,` : ''} is `
          + `${cover ? `about ${cover} days of cover` : 'enough'} — past the point StockChief can see. `
          + 'Ordering now would just be holding it sooner.' };
  }

  // Something is coming, and it gets here first.
  if (projection.coveredByIncoming) {
    return { ...base, order: false, reason: 'covered_by_incoming',
      headline: 'Covered by an order already placed',
      explanation: `Stock would run out around ${projection.stockoutDate}, but ${projection.nextArrival.units} `
        + `arrive on ${projection.nextArrival.date} from ${projection.nextArrival.supplierName || 'the supplier'}. `
        + 'Nothing more is needed.' };
  }

  // Moving stock beats buying it, when it will do.
  const usefulTransfer = (transfers.transfers || [])[0];
  if (usefulTransfer && goals.preferTransferBeforePurchasing) {
    return { ...base, order: false, reason: 'transfer_first',
      headline: `Move ${usefulTransfer.units} from ${usefulTransfer.fromLocationName} instead`,
      explanation: `${usefulTransfer.why} You asked StockChief to move stock before buying more.`,
      transfer: usefulTransfer };
  }

  if (!supplierItem) {
    return { ...base, order: false, reason: 'no_supplier',
      headline: 'Nothing to order from',
      explanation: `This is heading for a shortage around ${projection.stockoutDate}, but no supplier is `
        + 'linked to it, so StockChief cannot work out a pack size, a cost or a delivery time.' };
  }

  // --- how much ---------------------------------------------------------------

  const target = policy.targetStock !== null && policy.targetStock !== undefined
    ? policy.targetStock
    : (advice.advisable ? advice.recommended.target : null);
  const targetSource = policy.targetStock !== null && policy.targetStock !== undefined
    ? 'your configured target' : 'the level StockChief works out from demand and lead time';

  if (target === null) {
    return { ...base, order: false, reason: 'no_target',
      headline: 'Cannot work out a quantity',
      explanation: 'There is no target stock level configured and not enough demand history for StockChief '
        + 'to suggest one, so it will not invent a quantity.' };
  }

  const shortfall = Math.max(0, Math.ceil(target - (projection.onHand + projection.onOrder)));
  if (shortfall <= 0) {
    return { ...base, order: false, reason: 'at_target',
      headline: 'Nothing to order yet',
      explanation: `${projection.onHand} in stock plus ${projection.onOrder} on order already meets `
        + `${targetSource} of ${target}.` };
  }

  // Pack sizes and minimums are the supplier's rules and are never rounded past.
  const converted = supplierService.toPurchaseUnits(shortfall, supplierItem);
  const unitCost = supplierItem.lastUnitCost;
  const costMinor = unitCost === null || unitCost === undefined
    ? null : Math.round(unitCost * converted.units * 100);

  // --- when -------------------------------------------------------------------

  const orderBy = projection.stockoutDate && leadTime.planningDays !== null
    ? demandHistory.addDays(projection.stockoutDate, -Math.ceil(leadTime.planningDays))
    : null;
  const today = new Date(now).toISOString().slice(0, 10);
  const late = orderBy !== null && orderBy <= today;

  const urgency = projection.promiseMissedDate ? URGENCY.breaksCommitment
    : late ? URGENCY.breachesLeadTime
      : projection.daysUntilStockout <= URGENCY.soonDays ? 70 : 40;

  return {
    ...base,
    order: true,
    reason: late ? 'order_now' : 'order_by',
    quantityUnits: converted.units,
    quantityPurchaseUnits: converted.purchaseUnits,
    purchaseUnit: supplierItem.purchaseUnit,
    unitCost,
    costMinor,
    supplierId: supplierItem.supplierId,
    supplierName: supplierItem.supplierName,
    supplierItemId: supplierItem.id,
    target,
    shortfall,
    orderBy,
    urgency,
    packSteps: converted.steps,
    headline: late
      ? `Order ${converted.units} ${sku.displayName} now`
      : `Order ${converted.units} ${sku.displayName} by ${orderBy}`,
    explanation: explainPurchase({
      sku, projection, forecast, leadTime, converted, target, targetSource, orderBy, late, costMinor, currency,
    }),
    tradeoff: tradeoff({ converted, supplierItem, forecast, currency, projection }),
  };
}

function explainPurchase({ sku, projection, forecast, leadTime, converted, target, targetSource, orderBy, late, costMinor, currency }) {
  const parts = [];
  if (projection.promiseMissedDate) {
    parts.push(`Customers have already ordered more than there is stock for by ${projection.promiseMissedDate}.`);
  } else {
    const hedge = forecast.confidence === 'moderate' ? 'roughly ' : '';
    parts.push(`${projection.onHand} available and selling ${hedge}${forecast.dailyRate} a day, so this runs `
      + `out around ${projection.stockoutDate}.`);
  }
  if (leadTime.source === 'measured' && leadTime.material) {
    parts.push(`${leadTime.supplierName} has recently been taking about ${leadTime.planningDays} days rather `
      + `than the ${leadTime.configuredDays} configured, which StockChief is planning around.`);
  } else if (leadTime.planningDays !== null) {
    parts.push(`Delivery takes about ${leadTime.planningDays} days.`);
  }
  parts.push(late
    ? 'Ordering today already arrives after that, so this needs to go now.'
    : `Ordering by ${orderBy} arrives in time.`);
  parts.push(`${converted.units} brings stock up to ${targetSource} of ${target}`
    + (costMinor !== null ? `, costing about ${money(costMinor, currency)}.` : '.'));
  return parts.join(' ');
}

/**
 * The money side of ordering more than you need.
 *
 * Offered as a comparison rather than a warning. There are perfectly good
 * reasons to buy a bigger drop — a price break, a container, a supplier who is
 * about to close for a month — and StockChief cannot see any of them. What it can
 * see is the cash, so it says the cash.
 */
function tradeoff({ converted, supplierItem, forecast, currency, projection }) {
  const unitCost = supplierItem.lastUnitCost;
  if (unitCost === null || unitCost === undefined || !forecast.dailyRate) return null;
  const bigger = supplierService.toPurchaseUnits(Math.ceil(converted.units * 1.6), supplierItem);
  if (bigger.units <= converted.units) return null;
  const extraMinor = Math.round((bigger.units - converted.units) * unitCost * 100);
  const extraDays = round((bigger.units - converted.units) / forecast.dailyRate, 0);
  return {
    alternativeUnits: bigger.units,
    extraCostMinor: extraMinor,
    extraCoverDays: extraDays,
    text: `Ordering ${bigger.units} instead of ${converted.units} would add about ${extraDays} days of `
      + `cover and tie up a further ${money(extraMinor, currency)}.`,
  };
}

function skuAnomalies({ db, workspaceId, sku, history, projection, leadTime }) {
  const daysOfCover = projection.dailyRate && projection.dailyRate > 0
    ? projection.onHand / projection.dailyRate : null;
  const found = [
    anomalyEngine.demandShift({ history, displayName: sku.displayName, skuId: sku.skuId, daysOfCover }),
    anomalyEngine.largeOrder({ history, displayName: sku.displayName, skuId: sku.skuId }),
    anomalyEngine.returns({ history, displayName: sku.displayName, skuId: sku.skuId }),
    anomalyEngine.shrinkage(db, workspaceId, { skuId: sku.skuId, displayName: sku.displayName }),
    anomalyEngine.leadTimeDrift(leadTime),
  ].filter(Boolean);
  return found;
}

/**
 * The whole workspace, prioritised.
 *
 * Deliberately returns few things. The output feeds Home and Needs You, and a
 * list of forty is a list nobody reads — so shortages come first, ordered by
 * how soon and how badly they bite, and everything informational sits behind a
 * link.
 */
function sweep(db, workspaceId, options = {}) {
  const now = options.now || Date.now();
  const goals = goalsService.forWorkspace(db, workspaceId);
  const limit = Number(options.limit || 25);
  const asOf = new Date(now).toISOString().slice(0, 10);
  // Freeze workspace-wide evidence for this pass. Apart from making the sweep
  // scale, this guarantees every SKU in a pass is compared against the same
  // cash and inventory position instead of subtly different snapshots.
  const workspaceContext = {
    inventoryPosition: goalsService.inventoryPosition(db, workspaceId, goals),
    cash: adaptiveBrain.cashPosition(db, workspaceId, {
      asOf,
      horizonDays: Math.max(60, Number(goals.reviewDays || 7) + 30),
      reserveMinor: goals.cashReserveMinor || 0,
    }),
  };

  const scanLimit = Math.max(1, Math.min(5000, Number(options.scanLimit || 400)));
  const scheduledCoverageScan = !options.skuIds;
  let skuIds = options.skuIds;
  if (!skuIds) {
    const cursor = db.prepare(`SELECT last_key, completed_cycles FROM manager_scan_cursors
      WHERE workspace_id = ? AND scan_name = 'planning'`).get(workspaceId);
    const after = cursor?.last_key || '';
    const base = `FROM skus s WHERE s.workspace_id = ? AND s.is_active = 1
      AND (EXISTS (SELECT 1 FROM balances b WHERE b.sku_id = s.id AND b.on_hand > 0)
        OR EXISTS (SELECT 1 FROM sales_order_lines sol JOIN sales_orders so ON so.id = sol.sales_order_id
             WHERE sol.sku_id = s.id AND so.status NOT IN ('CANCELLED', 'COMPLETED', 'DRAFT')))`;
    let selected = db.prepare(`SELECT s.id ${base} AND s.id > ? ORDER BY s.id LIMIT ?`)
      .all(workspaceId, after, scanLimit);
    let completedCycles = Number(cursor?.completed_cycles || 0);
    if (selected.length < scanLimit) {
      const remaining = scanLimit - selected.length;
      const seen = new Set(selected.map((row) => row.id));
      const wrapped = db.prepare(`SELECT s.id ${base} ORDER BY s.id LIMIT ?`).all(workspaceId, remaining)
        .filter((row) => !seen.has(row.id));
      selected = [...selected, ...wrapped];
      completedCycles += 1;
    }
    skuIds = selected.map((row) => row.id);
    const next = skuIds.length ? skuIds[skuIds.length - 1] : null;
    db.prepare(`INSERT INTO manager_scan_cursors
      (workspace_id, scan_name, last_key, completed_cycles, updated_at)
      VALUES (?, 'planning', ?, ?, ?)
      ON CONFLICT(workspace_id, scan_name) DO UPDATE SET last_key = excluded.last_key,
        completed_cycles = excluded.completed_cycles, updated_at = excluded.updated_at`)
      .run(workspaceId, next, completedCycles, nowIso());
  }

  const shortages = [];
  const purchases = [];
  const policyChanges = [];
  const transfers = [];
  const findings = [];

  // A rotating coverage pass still observes every stocked SKU and advances its
  // durable cursor. Detailed demand/cash/supplier modelling is reserved for
  // SKUs with evidence that can change a decision. Receipt-only stock with no
  // supplier, rule, customer demand or outbound/correction history has no
  // evidenced action to compare; forecasting it would manufacture busywork and
  // turns a large catalogue into an endless queue of identical cold starts.
  let detailSkuIds = skuIds;
  if (scheduledCoverageScan && skuIds.length) {
    const placeholders = skuIds.map(() => '?').join(',');
    detailSkuIds = db.prepare(`SELECT s.id FROM skus s
      WHERE s.workspace_id=? AND s.id IN (${placeholders}) AND (
        EXISTS (SELECT 1 FROM reorder_policies rp WHERE rp.workspace_id=s.workspace_id AND rp.sku_id=s.id)
        OR EXISTS (SELECT 1 FROM supplier_items si WHERE si.workspace_id=s.workspace_id AND si.sku_id=s.id AND si.is_active=1)
        OR EXISTS (SELECT 1 FROM sales_order_lines sol JOIN sales_orders so ON so.id=sol.sales_order_id
          WHERE sol.workspace_id=s.workspace_id AND sol.sku_id=s.id
            AND so.status NOT IN ('DRAFT','FULFILLED','CANCELLED'))
        OR EXISTS (SELECT 1 FROM purchase_order_lines pol JOIN purchase_orders po ON po.id=pol.purchase_order_id
          WHERE pol.workspace_id=s.workspace_id AND pol.sku_id=s.id
            AND po.status NOT IN ('DRAFT','RECEIVED','CANCELLED'))
        OR EXISTS (SELECT 1 FROM movements m WHERE m.workspace_id=s.workspace_id AND m.sku_id=s.id
          AND m.operation IN ('issue','adjust'))
      )`).all(workspaceId, ...skuIds).map((row) => row.id);
  }

  for (const skuId of detailSkuIds) {
    let view;
    try {
      view = forSku(db, workspaceId, skuId, { now, goals, workspaceContext });
    } catch {
      // One unreadable product must never stop the sweep. A planning pass that
      // dies halfway silently stops protecting everything after it.
      continue;
    }
    if (!view) continue;

    if (view.projection.stockoutDate) {
      shortages.push({
        skuId, displayName: view.sku.displayName,
        stockoutDate: view.projection.stockoutDate,
        daysUntilStockout: view.projection.daysUntilStockout,
        breaksCommitment: Boolean(view.projection.promiseMissedDate),
        coveredByIncoming: view.projection.coveredByIncoming,
        incomingCoversMissedCommitment: view.projection.incomingCoversMissedCommitment,
        missedCommitment: view.projection.missedCommitment,
        shortfallUnits: view.projection.shortfallUnits,
        nextArrival: view.projection.nextArrival,
        onOrder: view.projection.onOrder,
        confidence: view.forecast.confidence,
        explanation: view.projection.explanation,
        purchase: view.purchase,
        adaptivePlan: view.adaptivePlan,
      });
    }
    if (view.purchase && view.purchase.order
        && ['BUY','BUY_ALTERNATE','EXPEDITE','TRANSFER_AND_BUY'].includes(view.adaptivePlan?.chosen?.type)) {
      purchases.push({ ...view.purchase, adaptivePlan:view.adaptivePlan });
    }
    for (const recommendation of view.advice.recommendations) {
      policyChanges.push({ skuId, displayName: view.sku.displayName, confidence: view.forecast.confidence, ...recommendation });
    }
    for (const transfer of view.transfers) transfers.push({ ...transfer, displayName: view.sku.displayName });
    for (const finding of view.anomalies) findings.push(finding);
  }

  for (const finding of anomalyEngine.purchaseQuantity(db, workspaceId, { now })) findings.push(finding);

  shortages.sort((a, b) => {
    if (a.breaksCommitment !== b.breaksCommitment) return a.breaksCommitment ? -1 : 1;
    if (a.coveredByIncoming !== b.coveredByIncoming) return a.coveredByIncoming ? 1 : -1;
    return (a.daysUntilStockout ?? 9999) - (b.daysUntilStockout ?? 9999);
  });

  return {
    ranAt: nowIso(),
    goals,
    inventoryPosition: goalsService.inventoryPosition(db, workspaceId, goals),
    shortages: shortages.slice(0, limit),
    purchases: purchases.sort((a, b) => (b.urgency || 0) - (a.urgency || 0)).slice(0, limit),
    policyChanges: policyChanges.slice(0, limit),
    transfers: transfers.slice(0, limit),
    decisions: findings.filter((row) => row.severity === anomalyEngine.SEVERITY.DECISION).slice(0, limit),
    informational: findings.filter((row) => row.severity !== anomalyEngine.SEVERITY.DECISION).slice(0, limit),
    scanned: skuIds.length,
    evaluated: detailSkuIds.length,
  };
}

/**
 * Runs the sweep and writes down what it found.
 *
 * The division of labour that keeps the pages fast: predicting is a background
 * job, and everywhere a recommendation appears is reading a table. A Needs You
 * page that forecast four hundred products on every load would be a Needs You
 * page nobody opens.
 *
 * Idempotent by construction. The same shortage found by the scheduler and by
 * a manual run on the same day is one recommendation, because the key is built
 * from what is being proposed rather than from when it was noticed.
 */
function sweepAndRecord(db, workspaceId, options = {}) {
  const now = options.now || Date.now();
  const scored = adaptiveBrain.scoreDue(db, workspaceId, { now });
  const result = sweep(db, workspaceId, options);
  const recorded = [];
  const decisionPlans = [];

  const keep = (row) => { if (row) recorded.push(row); };

  for (const shortage of result.shortages) {
    // Something already on its way is not a decision anybody has to take.
    if (shortage.coveredByIncoming) continue;
    const purchase = shortage.purchase;
    const plan = shortage.adaptivePlan;
    if (plan) decisionPlans.push(adaptiveBrain.record(db, workspaceId, shortage.skuId, plan));
    if (!purchase || !purchase.order || !plan
        || !['BUY','BUY_ALTERNATE','EXPEDITE'].includes(plan.chosen.type)) continue;
    const chosen = plan.chosen;
    keep(recommendations.record(db, workspaceId, {
      kind: 'order_now',
      subjectType: 'sku',
      skuId: shortage.skuId,
      supplierId: chosen.supplierId || purchase.supplierId || null,
      quantity: chosen.quantityUnits,
      valueMinor: chosen.totalCostMinor,
      currentValue: purchase.onHand,
      recommendedValue: chosen.quantityUnits,
      confidence: shortage.confidence,
      headline: plan.explanation,
      why: `${plan.explanation} This is a shadow recommendation; execution still requires its own authority.`,
      evidence: {
        stockoutDate: shortage.stockoutDate,
        daysUntilStockout: shortage.daysUntilStockout,
        breaksCommitment: shortage.breaksCommitment,
        onHand: purchase.onHand,
        onOrder: purchase.onOrder,
        committed: purchase.committed,
        leadTimeDays: purchase.leadTimeDays,
        orderBy: purchase.orderBy,
        supplierName: chosen.supplierName,
        tradeoff: purchase.tradeoff || null,
        adaptiveDecisionPlanId: decisionPlans[decisionPlans.length - 1].id,
        cash: plan.constraints.cash,
        alternatives: plan.alternatives.map((candidate) => ({ type:candidate.type,
          feasible:candidate.feasible, score:candidate.score, reasons:candidate.reasons })),
      },
    }, { now }));
  }

  for (const change of result.policyChanges) {
    keep(recommendations.record(db, workspaceId, {
      kind: change.kind,
      subjectType: 'sku',
      skuId: change.skuId,
      currentValue: change.current,
      recommendedValue: change.recommended,
      confidence: change.confidence,
      headline: change.headline,
      why: change.why,
      evidence: { direction: change.direction, actionLabel: change.actionLabel, keepLabel: change.keepLabel },
    }, { now }));
  }

  for (const transfer of result.transfers) {
    keep(recommendations.record(db, workspaceId, {
      kind: 'transfer',
      subjectType: 'sku',
      skuId: transfer.skuId,
      quantity: transfer.units,
      fromLocationId: transfer.fromLocationId,
      toLocationId: transfer.toLocationId,
      recommendedValue: transfer.units,
      confidence: transfer.confidence,
      headline: `Move ${transfer.units} ${transfer.displayName} from ${transfer.fromLocationName} to ${transfer.toLocationName}`,
      why: transfer.why,
      evidence: {
        fromLocationName: transfer.fromLocationName, toLocationName: transfer.toLocationName,
        sourceDaysOfCover: transfer.sourceDaysOfCover,
        destinationDaysOfCover: transfer.destinationDaysOfCover,
      },
    }, { now }));
  }

  for (const finding of result.decisions) {
    keep(recommendations.record(db, workspaceId, {
      kind: `anomaly:${finding.kind}`,
      subjectType: finding.supplierId ? 'supplier' : 'sku',
      skuId: finding.skuId || null,
      supplierId: finding.supplierId || null,
      headline: finding.headline,
      why: [finding.detail, finding.recommendation].filter(Boolean).join(' '),
      evidence: finding.measurements || {},
    }, { now }));
  }

  return { ...result, recorded, decisionPlans, scoredDecisionPlans:scored };
}

/** The overstock review, which is a workspace question rather than a per-product one. */
function excessReview(db, workspaceId, options = {}) {
  const goals = options.goals || goalsService.forWorkspace(db, workspaceId);
  return excessEngine.review(db, workspaceId, { ...options, goals });
}

/** Supplier performance, for the supplier page and for choosing between them. */
function supplierView(db, workspaceId, supplierId, options = {}) {
  return supplierReliability.forSupplier(db, workspaceId, supplierId, options);
}

module.exports = {
  forSku, sweep, sweepAndRecord, excessReview, supplierView, decidePurchase, describeSku, URGENCY,
};
