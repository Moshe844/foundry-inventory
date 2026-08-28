'use strict';

/**
 * What Foundry tells you it has been doing.
 *
 * Every sentence here is assembled from a work record: what was planned, which
 * policy allowed it, what the balances were before and after, and whether the
 * result verified. Nothing is generated to make the product look busy, and a
 * quiet day says so — "Foundry handled 14 tasks" is a lie if it handled none,
 * and it is the kind of lie that destroys trust in everything else on the page.
 *
 * Four questions, because that is what an operator actually wants to know:
 *
 *   is Foundry running        status
 *   what needs me             the exceptions, highest first
 *   what did Foundry do       completed work
 *   what happens next         real dated events, not predictions
 */

const modes = require('./modes');
const workItems = require('./work-items');
const policyService = require('./policy-service');
const position = require('../purchasing/position');
const poService = require('../purchasing/po-service');
const replenishmentPlan = require('../purchasing/replenishment-plan');
const attention = require('../attention/attention-engine');
const managerReadiness = require('../manager/readiness');
const { localDateKey } = require('../lib/calendar');

const DAY_MS = 24 * 60 * 60 * 1000;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
const json = (value, fallback = {}) => {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};

function timeAgo(iso, now = Date.now()) {
  if (!iso) return 'never';
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  return `${plural(Math.round(hours / 24), 'day')} ago`;
}

const shortDate = (iso) => {
  if (!iso) return null;
  return new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
};

/** The purchase order a work record produced or refers to, as it stands now. */
function currentOrderForWork(db, workspaceId, item) {
  const action = item.recommendedAction || {};
  const outcome = item.outcome || {};
  const orderId = item.purchaseOrderId || outcome.purchaseOrderId || action.purchaseOrderId || null;
  return orderId ? poService.find(db, workspaceId, orderId) : null;
}

/** One truthful sentence for the current lifecycle state of a purchase order. */
function orderStateCopy(order) {
  if (!order) return null;
  if (['DRAFT', 'AWAITING_APPROVAL'].includes(order.status)) {
    return `${order.poNumber} is a draft — ${plural(order.outstandingUnits, 'unit')} prepared, nothing on order.`;
  }
  if (['APPROVED', 'ORDERED'].includes(order.status)) {
    return `${order.poNumber} placed — ${plural(order.outstandingUnits, 'unit')} outstanding.`;
  }
  if (order.status === 'PARTIALLY_RECEIVED') {
    return `${order.poNumber} partially received — ${plural(order.receivedUnits, 'unit')} received, ` +
      `${plural(order.outstandingUnits, 'unit')} outstanding.`;
  }
  if (order.status === 'RECEIVED') {
    return `${order.poNumber} completed — all ${plural(order.receivedUnits, 'unit')} received.`;
  }
  if (order.status === 'CANCELLED') {
    return `${order.poNumber} cancelled — ${plural(order.receivedUnits, 'unit')} received before cancellation.`;
  }
  return `${order.poNumber} is ${String(order.status).toLowerCase().replaceAll('_', ' ')}.`;
}

/**
 * Whether a delivery reminder is genuinely actionable now.
 *
 * Old reminders are durable audit records, so a changed expected date or a
 * completed receipt must be reconciled at presentation time. A future order is
 * upcoming work, not a human exception.
 */
function deliveryState(db, workspaceId, item, { now = Date.now() } = {}) {
  if (item.category !== 'receiving_followup') return null;
  const action = item.recommendedAction || {};
  const order = currentOrderForWork(db, workspaceId, item);
  if (!order) return { actionable: false, order: null };

  const today = localDateKey(now);
  const expected = order.expectedDate || action.expectedDate || null;
  const open = order.isOpen && order.outstandingUnits > 0;
  const future = Boolean(expected && expected > today);
  const late = Boolean(expected && expected < today);
  const due = Boolean(expected && expected === today);

  return {
    order,
    expected,
    actionable: open && (due || late),
    future: open && future,
    due: open && due,
    late: open && late,
    title: future
      ? `${order.poNumber} expected ${shortDate(expected)} from ${order.supplierName}`
      : late
        ? `${order.poNumber} from ${order.supplierName} is late`
        : due
          ? `${order.poNumber} from ${order.supplierName} is due today`
          : orderStateCopy(order),
    detail: `${plural(order.outstandingUnits, 'unit')} outstanding.`,
  };
}

/** Work that still belongs in a customer's current action queue. */
function isCurrentlyActionable(db, workspaceId, item, options = {}) {
  if (!item.needsPerson) return false;
  const delivery = deliveryState(db, workspaceId, item, options);
  return delivery ? delivery.actionable : true;
}

/**
 * One line describing a piece of work, in a person's words.
 *
 * The history page groups work by what happened to it, so this is called for
 * items that are finished and items that never started. "Moved 15" against
 * something waiting for approval would be a plain untruth, so the verb follows
 * the status rather than the category.
 */
function describeCompleted(item, ownedByPlan = new Set(), currentOrder = null) {
  const action = item.recommendedAction || {};
  const outcome = item.outcome || {};
  const done = item.executionStatus === workItems.STATUS.COMPLETED;

  if (item.category === 'balance_transfer') {
    return {
      headline:
        `${done ? 'Moved' : 'Wants to move'} ${action.quantity} ${action.displayName} ` +
        `from ${action.fromLocationName} to ${action.toLocationName}`,
      detail:
        outcome.before && outcome.after
          ? `${action.fromLocationName} ${outcome.before.source} → ${outcome.after.source}, ` +
            `${action.toLocationName} ${outcome.before.destination} → ${outcome.after.destination}.`
          : null,
      verified: item.verificationStatus === 'VERIFIED',
      link: `/autopilot/work/${item.id}`,
    };
  }
  if (item.category === 'purchase_preparation') {
    return {
      headline:
        `${done ? 'Prepared' : 'Wants to prepare'} ${outcome.poNumber || 'a purchase order'} ` +
        `for ${(item.affectedEntities || {}).supplierName || 'a supplier'}`,
      // No unit costs on file means no total, and a bare "0" reads as a
      // zero-value order rather than as a price nobody has told Foundry.
      // Whether it is waiting for you depends on who owns the decision. Once a
      // replenishment plan contains this order, approving it is that plan's
      // decision, and saying otherwise sends someone looking for a button that
      // is deliberately no longer there.
      detail: outcome.lines === undefined
        ? null
        : `${plural(outcome.lines || 0, 'line')}, ` +
          `${Number(outcome.subtotal) > 0 ? outcome.subtotal : 'no prices on file yet'}. ` +
          (currentOrder
            ? orderStateCopy(currentOrder) +
              (['DRAFT', 'AWAITING_APPROVAL'].includes(currentOrder.status)
                ? ownedByPlan.has(currentOrder.id)
                  ? ' It is part of a replenishment plan, and is approved there.'
                  : ' Waiting for you to approve it.'
                : '')
            : ownedByPlan.has(item.purchaseOrderId)
              ? 'It is part of a replenishment plan, and is approved there.'
              : 'The purchase order record is no longer available.'),
      verified: true,
      link: item.purchaseOrderId ? `/purchasing/orders/${item.purchaseOrderId}` : `/autopilot/work/${item.id}`,
    };
  }
  if (item.category === 'receiving_followup') {
    return {
      headline: done
        ? `Marked ${action.poNumber || 'a delivery'} as dealt with`
        : `${action.poNumber || 'A delivery'} from ${action.supplierName || 'a supplier'} needs booking in`,
      detail: currentOrder
        ? orderStateCopy(currentOrder)
        : 'The purchase order record is no longer available.',
      verified: true,
      link: action.purchaseOrderId ? `/purchasing/orders/${action.purchaseOrderId}` : `/autopilot/work/${item.id}`,
    };
  }
  return {
    headline: item.categoryLabel,
    detail: null,
    verified: item.verificationStatus !== 'FAILED',
    link: `/autopilot/work/${item.id}`,
  };
}

/**
 * "What Foundry did."
 *
 * Counted from completed work plus the routine evaluation it performs, and
 * deliberately honest about the difference: reviewing 86 positions is not the
 * same kind of claim as moving twelve pairs of tights, so they are counted
 * separately rather than added together into an impressive-looking total.
 */
function whatFoundryDid(db, workspaceId, { since = null, now = Date.now() } = {}) {
  const from = since || new Date(now - DAY_MS).toISOString();
  const completed = workItems.completedSince(db, workspaceId, from);
  const evaluations = recentEvaluations(db, workspaceId, { since: from, limit: 20 });

  const sweeps = db
    .prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM attention_runs WHERE workspace_id = ? AND created_at >= ?')
    .get(workspaceId, from);
  const positionsWatched = db
    .prepare('SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ? AND is_active = 1')
    .get(workspaceId).n;
  const resolved = db
    .prepare(
      "SELECT COUNT(*) AS n FROM attention_items WHERE workspace_id = ? AND status = 'resolved' AND resolved_at >= ?"
    )
    .get(workspaceId, from).n;

  const ownedOrders = new Set(ordersOwnedByAPlan(db, workspaceId).keys());
  const actions = completed.map((item) => describeCompleted(
    item,
    ownedOrders,
    currentOrderForWork(db, workspaceId, item)
  ));
  const salesActions = db.prepare(`SELECT soe.id, soe.sales_order_id, soe.detail, soe.created_at,
      so.order_number, c.name AS customer_name
    FROM sales_order_events soe JOIN sales_orders so ON so.id = soe.sales_order_id
    JOIN customers c ON c.id = so.customer_id
    WHERE soe.workspace_id = ? AND soe.event_type = 'CONFIRMED' AND soe.created_at >= ?
    ORDER BY soe.created_at DESC LIMIT 8`).all(workspaceId, from).map((row) => {
      const detail = json(row.detail, {});
      const quantity = (detail.allocations || []).reduce((sum, line) => sum + Number(line.allocated || 0), 0);
      return quantity > 0 ? {
        id: row.id,
        headline: `Committed ${plural(quantity, 'unit')} to ${row.customer_name}`,
        detail: `${row.order_number} was allocated without reducing physical on-hand stock.`,
        link: `/sales/orders/${row.sales_order_id}`,
        verified: true,
      } : null;
    }).filter(Boolean);
  actions.push(...salesActions);
  const transfers = completed.filter((item) => item.category === 'balance_transfer');
  const purchases = completed.filter((item) => item.category === 'purchase_preparation');

  // Work Foundry has prepared and is holding. It carried nothing out, but
  // "nothing needed doing" would be false while it is standing there with
  // something that does.
  const prepared = workItems.awaitingApproval(db, workspaceId)
    .filter((item) => isCurrentlyActionable(db, workspaceId, item, { now })).length;

  return {
    since: from,
    actions,
    counts: {
      handled: completed.length + salesActions.length,
      transfers: transfers.length,
      unitsMoved: transfers.reduce((sum, item) => sum + ((item.recommendedAction || {}).quantity || 0), 0),
      purchasesPrepared: purchases.length,
      purchaseValue: purchases.reduce((sum, item) => sum + ((item.outcome || {}).subtotal || 0), 0),
      evaluations: evaluations.length,
      positionsWatched,
      findingsResolved: resolved,
    },
    evaluations,
    lastEvaluation: [sweeps.last, evaluations[0] && evaluations[0].finishedAt].filter(Boolean).sort().pop() || null,
    // The honest headline. Zero is a perfectly good number.
    headline:
      completed.length + salesActions.length === 0
        ? prepared > 0
          ? `Checked ${plural(positionsWatched, 'stock position')} and prepared ` +
            `${plural(prepared, 'thing')} for you. Carried nothing out on its own.`
          : evaluations.length > 0 || sweeps.n > 0
            ? `Checked ${plural(positionsWatched, 'stock position')}. Nothing needed doing.`
            : 'Nothing yet today.'
        : `Handled ${plural(completed.length + salesActions.length, 'task')}.`,
  };
}

/**
 * Purchase orders that a live replenishment plan has taken responsibility for.
 *
 * A plan whose order is already drafted stops proposing a new one and shows the
 * draft as its own — which left the draft listed separately as well, under
 * "ready to send", with its own approve button. Two live buttons for one order:
 * the plan, and the order it contains.
 *
 * The order is not hidden. It stays on the purchasing pages, in Activity and
 * inside the plan; what it loses is a second, independent decision alongside
 * the decision that already covers it.
 *
 * Matched by SKU rather than by a stored link, because the draft may predate
 * the plan entirely — that is exactly the case that went wrong.
 */
/** The stored action, shaped as the plan functions expect to read it. */
function planShape(action) {
  return {
    unitLabel: action.unitLabel || 'unit',
    transfers: action.transfers || [],
    purchase: action.purchase || null,
    prepared: action.prepared || null,
    onHandTotal: action.onHandTotal,
    onOrder: action.onOrder,
    networkPosition: action.networkPosition,
    reorderPoint: action.reorderPoint,
    target: action.target,
  };
}

const plan_unit = (action) => action.unitLabel || 'unit';

const counted = (quantity, label = 'unit') => {
  const value = Number(quantity) || 0;
  const clean = String(label || 'unit').replace(/\(s\)$/i, '').trim() || 'unit';
  const word = value === 1 || /s$/i.test(clean) ? clean : `${clean}s`;
  return `${value} ${word}`;
};

/**
 * The short, customer-facing decision shown above the audit evidence.
 *
 * Replenishment used to lead with every internal quantity at once. In
 * particular, a location-level balancing need could sit beside the network
 * purchase shortfall and make a correct order quantity look contradictory.
 * This copy answers one question first: what will approval do, and why is that
 * exact quantity being proposed?
 */
function pendingReplenishmentCopy(item, action, actions, breakdown) {
  if (item.category !== 'replenishment_plan' || item.isTerminal || !breakdown) return null;

  const now = actions.filter((entry) => entry.when === 'now');
  const preparing = now.filter((entry) => entry.kind === 'prepare_order');
  const placing = now.filter((entry) => entry.kind === 'place_order');
  const transferring = now.filter((entry) => entry.kind === 'transfer');
  const draftUnits = preparing.reduce((total, entry) => total + (entry.units || 0), 0);
  const placedUnits = placing.reduce((total, entry) => total + (entry.units || 0), 0);
  const movedUnits = transferring.reduce((total, entry) => total + (entry.quantity || 0), 0);
  const orderedUnits = draftUnits || placedUnits || 0;
  const purchase = action.purchase || null;
  const purchaseQuantity = purchase && purchase.quantityPurchaseUnits !== purchase.quantityUnits
    ? `${counted(purchase.quantityPurchaseUnits, purchase.purchaseUnit)} (${counted(purchase.quantityUnits, action.unitLabel)})`
    : counted(orderedUnits, action.unitLabel);
  const displayName = (item.affectedEntities || {}).displayName || action.displayName || 'this item';
  const shortfall = Math.max(0, Number(action.target || 0) - Number(action.networkPosition || 0));
  const supplierName = (action.purchase || {}).supplierName
    || ((action.prepared || {}).orders || [])[0]?.supplierName
    || null;
  const source = item.sourceEvidence || [];
  const issued = source.find((fact) => /^Issued in last /i.test(fact.label || ''));
  const leadTime = source.find((fact) => fact.label === 'Lead time');
  const unitCost = source.find((fact) => /unit cost/i.test(fact.label || ''));
  const onlyDraft = preparing.length === 1 && now.length === 1;
  const onlyPlacement = placing.length === 1 && now.length === 1;
  const onlyTransfer = transferring.length === 1 && now.length === 1;
  const kind = onlyDraft ? 'draft' : onlyPlacement ? 'placement' : onlyTransfer ? 'transfer' : 'combined';

  const heading = onlyDraft
    ? `Create a draft order for ${purchaseQuantity}?`
    : onlyPlacement
      ? `Place the prepared order for ${counted(placedUnits, action.unitLabel)}?`
      : onlyTransfer
        ? `Move ${counted(movedUnits, action.unitLabel)} between locations?`
        : `Approve replenishment for ${displayName}?`;

  const primaryLabel = onlyDraft
    ? `Create draft order for ${purchase && purchase.quantityPurchaseUnits !== purchase.quantityUnits
      ? counted(purchase.quantityPurchaseUnits, purchase.purchaseUnit)
      : draftUnits}`
    : onlyPlacement
      ? `Place order for ${placedUnits}`
      : onlyTransfer
        ? `Approve transfer of ${movedUnits}`
        : 'Approve replenishment plan';

  let approvalEffect;
  let approvalLimit;
  if (onlyDraft) {
    approvalEffect = `Foundry will create a draft purchase order for ${purchaseQuantity}` +
      `${supplierName ? ` from ${supplierName}` : ''}.`;
    approvalLimit = 'It will not place the order, contact the supplier, or change on-hand stock.';
  } else if (onlyPlacement) {
    approvalEffect = `Foundry will record the prepared order for ${counted(placedUnits, action.unitLabel)} as placed.`;
    approvalLimit = 'On-hand stock will not change until the delivery is received.';
  } else if (onlyTransfer) {
    const transfer = (action.transfers || [])[0] || {};
    approvalEffect = `Move ${counted(movedUnits, action.unitLabel)} from ` +
      `${transfer.fromLocationName || 'the source location'} to ${transfer.toLocationName || 'the destination location'}.`;
    approvalLimit = 'The total quantity will not change; stock will only move between locations.';
  } else {
    approvalEffect = now.map((entry) => entry.text).join(' Then ') + '.';
    approvalLimit = preparing.length
      ? 'Any newly prepared purchase order remains a draft until it is separately placed.'
      : 'Foundry will carry out only the actions listed here.';
  }

  const orderRule = orderedUnits
    ? orderedUnits === shortfall
      ? `Target ${action.target} − current position ${action.networkPosition} = ${shortfall} to add.`
      : purchase && purchase.unitsPerPurchaseUnit > 1
        ? `Target ${action.target} − current position ${action.networkPosition} = ${shortfall} needed. ` +
          `${supplierName || 'The supplier'} sells ${purchase.purchaseUnit}s of ${purchase.unitsPerPurchaseUnit}, ` +
          `so Foundry rounds up to ${counted(purchase.quantityPurchaseUnits, purchase.purchaseUnit)} ` +
          `(${counted(purchase.quantityUnits, action.unitLabel)}).`
        : `Target ${action.target} − current position ${action.networkPosition} = ${shortfall} needed. ` +
          `Supplier minimum or ordering-multiple rules increase the purchasable quantity to ${orderedUnits}.`
    : null;

  const stages = [
    {
      label: 'Now',
      onHand: breakdown.onHand,
      drafted: breakdown.drafted,
      onOrder: breakdown.onOrder,
      covered: breakdown.onHand + breakdown.onOrder + breakdown.drafted,
    },
    {
      label: 'After approval',
      onHand: breakdown.after.onHand,
      drafted: breakdown.after.drafted,
      onOrder: breakdown.after.onOrder,
      covered: breakdown.after.onHand + breakdown.after.onOrder + breakdown.after.drafted,
    },
  ];
  if (breakdown.after.drafted > 0) {
    stages.push({
      label: 'After the draft is placed',
      onHand: breakdown.after.onHand,
      drafted: 0,
      onOrder: breakdown.after.onOrder + breakdown.after.drafted,
      covered: breakdown.after.onHand + breakdown.after.onOrder + breakdown.after.drafted,
    });
  }
  if (breakdown.afterEveryOrderArrives > breakdown.after.onHand) {
    stages.push({
      label: 'After delivery is received',
      onHand: breakdown.afterEveryOrderArrives,
      drafted: 0,
      onOrder: 0,
      covered: breakdown.afterEveryOrderArrives,
    });
  }

  return {
    kind,
    heading,
    status: 'Your approval is needed.',
    primaryLabel,
    secondaryLabel: 'Not now',
    summary: onlyTransfer
      ? `${(action.byLocation || []).map((location) => `${location.locationName} has ${location.onHand}`).join('; ')}. ` +
        `Moving ${movedUnits} puts the stock where it is needed without changing the ${breakdown.onHand} total.`
      : `You have ${breakdown.onHand} on hand and ${breakdown.onOrder} already on order. ` +
        `Your reorder point is ${action.reorderPoint}, and your target is ${action.target}.`,
    orderRule,
    approvalEffect,
    approvalLimit,
    supplierName,
    issued,
    leadTime,
    unitCost,
    locationDetail: (action.byLocation || [])
      .map((location) => `${location.locationName}: ${location.onHand} on hand${location.need ? `, ${location.need} needed for its location target` : ''}`),
    movementRows: ((action.after || {}).byLocation || []).map((location) => ({
      locationName: location.locationName,
      before: location.before,
      after: location.after,
    })),
    stages,
  };
}

function ordersOwnedByAPlan(db, workspaceId) {
  const owned = new Map();
  const live = workItems
    .list(db, workspaceId, { category: 'replenishment_plan', limit: 200 })
    .filter((item) => !item.isTerminal);
  if (!live.length) return owned;

  const bySku = new Map();
  for (const plan of live) {
    const skuId = (plan.affectedEntities || {}).skuId || (plan.recommendedAction || {}).skuId;
    if (skuId) bySku.set(skuId, plan);
  }
  if (!bySku.size) return owned;

  const placeholders = [...bySku.keys()].map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT l.purchase_order_id AS orderId, l.sku_id AS skuId
         FROM purchase_order_lines l
         JOIN purchase_orders po ON po.id = l.purchase_order_id
        WHERE l.workspace_id = ? AND po.status IN ('DRAFT', 'AWAITING_APPROVAL')
          AND l.sku_id IN (${placeholders})`
    )
    .all(workspaceId, ...bySku.keys());

  for (const row of rows) {
    const plan = bySku.get(row.skuId);
    if (plan) owned.set(row.orderId, plan);
  }
  return owned;
}

/** Work Foundry has worked out already and is holding for review. */
function whatFoundryPrepared(db, workspaceId, { limit = 8 } = {}) {
  const planOwned = ordersOwnedByAPlan(db, workspaceId);
  const waitingItems = workItems.awaitingApproval(db, workspaceId)
    .filter((item) => isCurrentlyActionable(db, workspaceId, item))
    // Approving a purchase order the plan contains is the plan's decision.
    .filter((item) => {
      const orderId = item.purchaseOrderId || (item.recommendedAction || {}).purchaseOrderId;
      return !(orderId && planOwned.has(orderId));
    });
  const waitingOrderIds = new Set(waitingItems
    .map((item) => item.purchaseOrderId || (item.recommendedAction || {}).purchaseOrderId)
    .filter(Boolean));
  const waiting = waitingItems.map((item) => {
    const delivery = deliveryState(db, workspaceId, item);
    const blockedSupplier = item.category === 'replenishment_plan'
      && (item.recommendedAction || {}).blocked === 'no_supplier';
    return ({
    kind: 'work',
    id: item.id,
    title:
      item.category === 'balance_transfer'
        ? `Move ${item.recommendedAction.quantity} ${item.recommendedAction.displayName} to ${item.recommendedAction.toLocationName}?`
        : item.category === 'receiving_followup'
          ? delivery.title
          : item.category === 'purchase_approval' && item.source === 'price_exception'
            ? `${item.recommendedAction.poNumber || 'A purchase order'} has a price exception`
            : item.category === 'purchase_approval'
              ? `${item.recommendedAction.poNumber || 'A purchase order'} for ${item.recommendedAction.supplierName || 'the supplier'} is ready to send`
            // Named for the product, like everywhere else. "Replenishment plan"
            // with no subject is the internal category showing through.
            : item.category === 'replenishment_plan' && (item.affectedEntities || {}).displayName
              ? blockedSupplier
                ? `${item.affectedEntities.displayName} needs a supplier`
                : `${item.affectedEntities.displayName} needs replenishing`
            : item.categoryLabel,
    because: (item.recommendedAction || {}).explanation || (item.policyEvaluation || {}).reason || null,
    evidence: item.sourceEvidence || [],
    priority: item.priority,
    // A delivery reminder should land on the order, where one button books the
    // whole thing in — not on an explanation of why Foundry raised it.
    link:
      blockedSupplier && item.recommendedAction.skuId
        ? `/purchasing/supplier-for/${item.recommendedAction.skuId}`
        : item.category === 'receiving_followup' && item.recommendedAction.purchaseOrderId
        ? `/purchasing/orders/${item.recommendedAction.purchaseOrderId}`
        : `/autopilot/work/${item.id}`,
    action: blockedSupplier ? 'Add supplier' : item.category === 'receiving_followup' ? 'Book it in' : 'Review',
  });
  });

  // An order a plan already speaks for is reviewed through that plan.
  const ownedByPlan = ordersOwnedByAPlan(db, workspaceId);

  const drafts = db
    .prepare(
      `SELECT po.id, po.po_number, s.name AS supplier, po.status FROM purchase_orders po
         JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.workspace_id = ? AND po.status = 'DRAFT' ORDER BY po.created_at DESC LIMIT 5`
    )
    .all(workspaceId)
    .filter((row) => !waitingOrderIds.has(row.id))
    .filter((row) => !ownedByPlan.has(row.id))
    .map((row) => ({
      kind: 'purchase',
      id: row.id,
      title: `${row.po_number} for ${row.supplier} is ready to send`,
      because: 'Foundry prepared it. Nothing has been ordered.',
      evidence: [],
      priority: 55,
      link: `/purchasing/orders/${row.id}`,
      action: 'Review & approve',
    }));

  return [...waiting, ...drafts]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
}

/**
 * Completed manager evaluations are real work evidence even when they correctly
 * produce no inventory mutation. They are kept separate from handled actions so
 * the page never inflates "checked" into "moved" or "ordered".
 */
function recentEvaluations(db, workspaceId, { since = null, limit = 20 } = {}) {
  const clauses = ['workspace_id = ?', 'finished_at IS NOT NULL'];
  const params = [workspaceId];
  if (since) {
    clauses.push('finished_at >= ?');
    params.push(since);
  }
  const positions = db
    .prepare('SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ? AND is_active = 1')
    .get(workspaceId).n;
  const readiness = managerReadiness.assess(db, workspaceId);
  const triggerLabels = {
    scheduled: 'Scheduled inventory check',
    startup: 'Restart recovery check',
    manual: 'Inventory check you requested',
    receive: 'Checked inventory after stock arrived',
    issue: 'Checked inventory after stock left',
    adjust: 'Checked inventory after a count changed',
    transfer: 'Checked inventory after a transfer',
  };

  return db
    .prepare(
      `SELECT * FROM work_plans WHERE ${clauses.join(' AND ')}
       ORDER BY finished_at DESC, rowid DESC LIMIT ?`
    )
    .all(...params, limit)
    .map((row) => {
      const summary = json(row.summary, {});
      const declined = Array.isArray(summary.declined) ? summary.declined : [];
      const missingHistory = declined.filter((entry) => entry.reason === 'not_enough_history').length;
      const planned = Number(row.items_planned || 0);
      const awaiting = Number(row.items_awaiting || 0);
      const detail = planned
        ? `${plural(planned, 'work item')} was prepared in that check; ${plural(awaiting, 'item')} required a decision at the time.`
        : missingHistory
          ? `${plural(positions, 'stock position')} checked. ${plural(missingHistory, 'position')} lacked enough outbound history for safe demand action.`
          : !readiness.canAssessDemand && positions
            ? `${plural(positions, 'stock position')} checked. No action was supported; demand history is not usable yet.`
            : `${plural(positions, 'stock position')} checked. No transfer, purchase, delivery follow-up, or policy conflict was supported.`;
      return {
        id: row.id,
        trigger: row.trigger,
        title: triggerLabels[row.trigger] || `Inventory check: ${String(row.trigger || 'manager').replaceAll('-', ' ')}`,
        detail,
        planned,
        awaiting,
        summary,
        finishedAt: row.finished_at,
      };
    });
}

/** "Foundry needs you." Genuine exceptions, most consequential first. */
function whatNeedsYou(db, workspaceId, { limit = 8 } = {}) {
  const activeWork = workItems.list(db, workspaceId, { limit: 200 })
    .filter((item) => !item.isTerminal || item.category === 'purchase_preparation');
  const workCoveredSkus = new Set(activeWork.flatMap((item) => [
    item.affectedEntities && item.affectedEntities.skuId,
    ...((item.recommendedAction && item.recommendedAction.lines) || []).map((line) => line.skuId),
  ]).filter(Boolean));
  return attention
    .listAttention(db, workspaceId)
    .filter((item) => ['critical', 'important'].includes(item.severity))
    // A worked replenishment plan belongs here above all: a configured level
    // being crossed is the definition of something needing a person, and it
    // reached nobody while this list did not name it.
    .filter((item) => [
      'replenishment_needed', 'stock_protection_boundary', 'low_stock', 'stockout_risk', 'unusual_adjustment',
      'data_integrity', 'supplier_price_change',
    ].includes(item.category))
    .filter((item) => !['low_stock', 'stockout_risk', 'replenishment_needed'].includes(item.category) || !workCoveredSkus.has(item.skuId))
    .map((item) => {
      const needsSupplier = item.category === 'replenishment_needed'
        && (item.metrics || {}).blocked === 'no_supplier';
      return ({
      kind: 'finding',
      // The hydrated finding calls its own key attentionId. Reading `id` here
      // produced a Review button pointing at /attention/undefined.
      id: item.attentionId,
      category: item.category,
      title: item.narrativeTitle || item.title,
      because: item.conciseSummary,
      recommendation: item.recommendation,
      evidence: item.evidence || [],
      metrics: item.metrics || {},
      priority: item.priorityScore || 50,
      link: needsSupplier && item.skuId
        ? `/purchasing/supplier-for/${item.skuId}`
        : `/attention/${item.attentionId}`,
      action: needsSupplier ? 'Add supplier' : 'Review',
    }); })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
}

/**
 * "What's happening next."
 *
 * Only things with a real date attached: an expected delivery, a lot's expiry,
 * the next evaluation. No projections dressed up as facts.
 */
function whatsNext(db, workspaceId, { now = Date.now(), days = 14 } = {}) {
  const events = [];

  for (const po of position.arrivingSoon(db, workspaceId, { days, now })) {
    events.push({
      when: po.expected_date,
      title: `${po.po_number} expected ${shortDate(po.expected_date)} from ${po.supplier_name}`,
      detail: `${plural(po.outstanding_units, 'unit')} outstanding.`,
      link: `/purchasing/orders/${po.id}`,
    });
  }
  for (const po of position.lateOrders(db, workspaceId, { now })) {
    events.push({
      when: po.expected_date,
      title: `${po.po_number} is ${plural(po.daysLate, 'day')} late`,
      detail: `${plural(po.outstanding_units, 'unit')} still outstanding from ${po.supplier_name}.`,
      overdue: true,
      link: `/purchasing/orders/${po.id}`,
    });
  }

  // Healthy customer commitments stay quiet until their requested date is
  // close. Backorders are excluded because those already belong in Needs You.
  const today = new Date(now).toISOString().slice(0, 10);
  const salesUntil = new Date(now + days * DAY_MS).toISOString().slice(0, 10);
  for (const order of db.prepare(`SELECT so.id, so.order_number, so.needed_by, c.name AS customer_name,
      COALESCE(SUM(sol.quantity_ordered - sol.quantity_fulfilled), 0) AS outstanding,
      COALESCE(SUM((SELECT SUM(soa.quantity) FROM sales_order_allocations soa
                    WHERE soa.sales_order_line_id = sol.id)), 0) AS committed
    FROM sales_orders so JOIN customers c ON c.id = so.customer_id
    JOIN sales_order_lines sol ON sol.sales_order_id = so.id
    WHERE so.workspace_id = ? AND so.status IN ('CONFIRMED','PARTIALLY_FULFILLED')
      AND so.needed_by IS NOT NULL AND so.needed_by <= ?
    GROUP BY so.id HAVING committed >= outstanding
    ORDER BY so.needed_by, so.created_at LIMIT 8`).all(workspaceId, salesUntil)) {
    events.push({
      when: order.needed_by,
      title: `${order.customer_name} — ${plural(order.outstanding, 'unit')} due ${shortDate(order.needed_by)}`,
      detail: `${order.order_number} is fully committed and ready for fulfillment.`,
      overdue: order.needed_by < today,
      link: `/sales/orders/${order.id}`,
    });
  }

  const until = salesUntil;
  for (const lot of db
    .prepare(
      `SELECT l.code, l.expires_at, i.name, SUM(lb.quantity) AS quantity
         FROM lot_balances lb JOIN lots l ON l.id = lb.lot_id
         JOIN skus s ON s.id = l.sku_id JOIN items i ON i.id = s.item_id
        WHERE lb.workspace_id = ? AND lb.quantity > 0 AND l.expires_at IS NOT NULL AND l.expires_at <= ?
        GROUP BY l.id ORDER BY l.expires_at LIMIT 5`
    )
    .all(workspaceId, `${until}T23:59:59.999Z`)) {
    events.push({
      when: String(lot.expires_at).slice(0, 10),
      title: `${lot.name} lot ${lot.code} reaches its date`,
      detail: `${plural(lot.quantity, 'unit')} still on hand.`,
      link: '/attention',
    });
  }

  const state = modes.get(db, workspaceId);
  if (state.nextEvaluationAt) {
    events.push({
      when: String(state.nextEvaluationAt).slice(0, 10),
      title: 'Next scheduled evaluation',
      detail: null,
    });
  }

  return events.sort((a, b) => String(a.when).localeCompare(String(b.when))).slice(0, 8);
}

/**
 * What Foundry has told this inventory lately.
 *
 * In-app only. Mission 7 asks for a notification boundary, not for email or
 * SMS, and a channel that silently drops messages is worse than one that was
 * never promised.
 */
function notifications(db, workspaceId, { limit = 20, unreadOnly = false } = {}) {
  const clause = unreadOnly ? ' AND read_at IS NULL' : '';
  return db
    .prepare(
      `SELECT * FROM notifications WHERE workspace_id = ?${clause}
        ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(workspaceId, limit)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      title: row.title,
      body: row.body,
      link: row.link,
      workItemId: row.work_item_id,
      read: Boolean(row.read_at),
      createdAt: row.created_at,
      when: timeAgo(row.created_at),
    }));
}

/** Everything Operator Home needs, in one read. */
function operatorHome(db, workspaceId, { now = Date.now() } = {}) {
  const state = modes.get(db, workspaceId);
  const policies = policyService.list(db, workspaceId, { activeOnly: true });
  const did = whatFoundryDid(db, workspaceId, { now });

  // "Last checked" means the last time Foundry looked at this inventory, by any
  // route. Reading only the autopilot's own stamp said "never" on a workspace
  // that had just been swept, next to a count of the sweeps.
  const lastLooked = [state.lastEvaluatedAt, did.lastEvaluation]
    .filter(Boolean)
    .sort()
    .pop() || null;

  const onboarding = db
    .prepare('SELECT path, status FROM workspace_onboarding WHERE workspace_id = ?')
    .get(workspaceId);
  const setupItem = onboarding && onboarding.status !== 'ready'
    ? db
        .prepare(
          `SELECT i.id, i.name, COUNT(s.id) AS sku_count
             FROM items i LEFT JOIN skus s ON s.item_id = i.id
            WHERE i.workspace_id = ? AND i.is_active = 1
            GROUP BY i.id ORDER BY i.created_at LIMIT 1`
        )
        .get(workspaceId)
    : null;

  const investigations = require('../manager/investigations');
  const managerBrief = require('../manager/brief').build(db, workspaceId, { now });
  const inbox = require('../manager/needs-you-inbox').inbox(db, workspaceId);
  const readiness = managerReadiness.assess(db, workspaceId, { now });
  if (!policies.length) readiness.notes.push('Foundry has no standing authority; it will prepare consequential work for approval.');
  const operatingNeeds = managerReadiness.decisions(db, workspaceId, { now, readiness });
  const investigationNeeds = investigations.list(db, workspaceId, {
    statuses: ['NEEDS_HUMAN', 'INCONCLUSIVE'], limit: 25,
  }).map((entry) => ({
    id: entry.investigationId,
    title: entry.affectedEntities.displayName
      ? `Count discrepancy: ${entry.affectedEntities.displayName}`
      : 'Inventory discrepancy',
    because: entry.recommendedNextStep,
    link: `/investigations/${entry.investigationId}`,
    action: 'Review evidence',
  }));
  const physicalNeeds = db.prepare(
    `SELECT id, event_type, stated_as FROM physical_events WHERE workspace_id = ?
      AND status = 'NEEDS_HUMAN' ORDER BY created_at DESC LIMIT 25`
  ).all(workspaceId).map((entry) => ({ id: entry.id,
    title: entry.event_type.replaceAll('_', ' '), because: entry.stated_as,
    link: '/needs-you', action: 'Add details' }));
  const prepared = whatFoundryPrepared(db, workspaceId);
  const handling = workItems.list(db, workspaceId, {
    status: [workItems.STATUS.DETECTED, workItems.STATUS.PLANNED, workItems.STATUS.AUTHORIZED,
      workItems.STATUS.EXECUTING, workItems.STATUS.VERIFYING], limit: 25,
  }).map((item) => ({ id: item.id, title: item.categoryLabel,
    because: item.policyEvaluation.reason || 'Foundry is working through this now.',
    link: `/autopilot/work/${item.id}`, action: 'See work', status: item.executionStatus }));

  return {
    status: {
      ...state,
      lastEvaluatedText: timeAgo(lastLooked, now),
      activePolicies: policies.length,
      policySummary: policies.map((policy) => policy.name),
      headline: state.paused
        ? 'Foundry is paused'
        : state.suspended
          ? `Foundry paused automatic ${state.suspendedScope || 'work'}`
          : state.mode === 'OBSERVE'
            ? 'Foundry is watching this inventory'
            : state.mode === 'SUPERVISED'
              ? 'Foundry is preparing your inventory work'
              : 'Foundry is running this inventory',
    },
    did,
    needsYou: inbox.map((entry) => ({
      id: entry.id,
      title: entry.title,
      because: entry.happened,
      link: entry.href,
      action: entry.actionLabel,
      importance: entry.importance,
    })),
    handling,
    prepared,
    managerBrief,
    readiness,
    next: whatsNext(db, workspaceId, { now }),
    notifications: notifications(db, workspaceId, { limit: 6 }),
    setup: onboarding && onboarding.status !== 'ready'
      ? {
          path: onboarding.path,
          status: onboarding.status,
          item: setupItem || null,
          link: setupItem ? `/foundry/quantities/${setupItem.id}` : '/onboarding',
        }
      : null,
    unreadNotifications: db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE workspace_id = ? AND read_at IS NULL')
      .get(workspaceId).n,
  };
}

/** Live stock and incoming position for the product behind a replenishment record. */
function replenishmentCurrentState(db, workspaceId, item) {
  if (item.category !== 'replenishment_plan') return null;
  const action = item.recommendedAction || {};
  const skuId = (item.affectedEntities || {}).skuId || action.skuId;
  if (!skuId) return null;
  const current = position.positionForSku(db, workspaceId, skuId);
  const order = currentOrderForWork(db, workspaceId, item);
  return {
    ...current,
    order,
    summary:
      `${current.onHand} on hand + ${current.onOrder} on order = ` +
      `inventory position ${current.position}.`,
  };
}

/** Human-readable verification claims, including live state for purchase work. */
function verificationFor(item, currentResult) {
  const raw = (item.outcome || {}).checks || [];
  return raw.map((check) => {
    if (check.name) return { ok: check.ok !== false, text: check.name };
    if (check.kind === 'transfer') {
      return {
        ok: check.ok !== false,
        text:
          `Verified transfer: ${check.quantity} units moved from ${check.from} to ${check.to}; ` +
          `source ${check.sourceBefore} → ${check.sourceAfter}, destination ` +
          `${check.destinationBefore} → ${check.destinationAfter}.`,
      };
    }
    if (check.kind === 'purchase' && currentResult && currentResult.order) {
      const order = currentResult.order;
      const state = ['DRAFT', 'AWAITING_APPROVAL'].includes(order.status)
        ? `${order.poNumber} is a draft; ${plural(order.outstandingUnits, 'unit')} are prepared; ` +
          'nothing is on order'
        : ['APPROVED', 'ORDERED'].includes(order.status)
          ? `${order.poNumber} is placed; ${plural(order.outstandingUnits, 'unit')} are on order`
          : order.status === 'PARTIALLY_RECEIVED'
            ? `${order.poNumber} is partially received; ${plural(order.receivedUnits, 'unit')} received and ` +
              `${plural(order.outstandingUnits, 'unit')} remain on order`
            : order.status === 'RECEIVED'
              ? `${order.poNumber} is completed; all ${plural(order.receivedUnits, 'unit')} received and ` +
                'nothing remains on order'
              : orderStateCopy(order).replace(/\.$/, '');
      return {
        ok: check.ok !== false,
        text: `Verified current state: ${state}; on-hand is ${currentResult.onHand}.`,
      };
    }
    if (check.kind === 'purchase') {
      return {
        ok: check.ok !== false,
        text: check.poNumber
          ? `Verified purchase-order step: ${check.poNumber} is ${String(check.status || 'recorded').toLowerCase()}.`
          : `Purchase-order verification ${check.ok === false ? 'failed' : 'passed'}.`,
      };
    }
    return {
      ok: check.ok !== false,
      text: check.detail || check.error || 'Verification completed.',
    };
  });
}

/**
 * Evidence on finished work is a snapshot, not a live settings panel.
 * Naming the lead-time row simply "Lead time" made an old 13-day input look
 * like it contradicted a supplier now configured at 15 days.
 */
function evidenceForDisplay(item) {
  const terminalReplenishment = item.category === 'replenishment_plan'
    && [workItems.STATUS.COMPLETED, workItems.STATUS.SUPERSEDED].includes(item.executionStatus);
  return (item.sourceEvidence || []).map((fact) => {
    if (item.category === 'replenishment_plan' && !terminalReplenishment) {
      if (fact.label === 'Lead time') return { ...fact, label: 'Planning lead time' };
      if (fact.label === 'Shortfall') return { ...fact, label: 'Amount needed to reach target' };
      if (/unit cost/i.test(fact.label || '') && Number.isFinite(Number(fact.value))) {
        return { ...fact, label: 'Last recorded unit cost', value: `$${Number(fact.value).toFixed(2)} per unit` };
      }
    }
    if (!terminalReplenishment || fact.label !== 'Lead time') return fact;
    return {
      ...fact,
      label: item.executionStatus === workItems.STATUS.COMPLETED
        ? 'Lead time used when plan was created'
        : 'Lead time used in the replaced plan',
    };
  });
}

/**
 * "Why did you do that?"
 *
 * Answered with the business evidence — the measurements that triggered it, the
 * policy that allowed it, the arithmetic, and the verified result. Never with
 * anything resembling a model's reasoning, because a model did not decide this.
 */
function explain(db, workspaceId, workItemId) {
  const item = workItems.get(db, workspaceId, workItemId);
  const action = item.recommendedAction || {};
  const outcome = item.outcome || {};
  const policy = item.policyId ? policyService.get(db, workspaceId, item.policyId) : null;
  const currentOrder = currentOrderForWork(db, workspaceId, item);
  const currentResult = replenishmentCurrentState(db, workspaceId, item);

  const paragraphs = [];
  let orderLink = null;

  // Said before anything else, and in the past tense. Work a plan has taken
  // over still described as "I want to move 45. Nothing has moved yet." reads
  // as pending, which is the one thing it is not.
  const supersededBy = (outcome || {}).supersededByWorkItemId || null;
  if (item.executionStatus === workItems.STATUS.SUPERSEDED) {
    paragraphs.push(
      'This was replaced before it ran. One replenishment plan now covers this stock need, ' +
        'including this action, so it is kept here as a record and cannot be approved or carried out.'
    );
  }

  if (item.category === 'balance_transfer') {
    const evidence = Object.fromEntries((item.sourceEvidence || []).map((entry) => [entry.label, entry.value]));
    const toName = action.toLocationName;
    const fromName = action.fromLocationName;

    paragraphs.push(
      `${toName} had ${evidence[`${toName} on hand`]} left and had issued ` +
        `${evidence[`${toName} issued (30 days)`]} during the previous 30 days. ` +
        `${fromName} had ${evidence[`${fromName} on hand`]}.`
    );
    // Tense is not a style choice here. This page is read to find out what
    // Foundry did, and describing a proposal in the past tense — or claiming an
    // approval nobody gave — is the one mistake that would make every other
    // sentence on it worthless.
    const done = item.executionStatus === workItems.STATUS.COMPLETED;

    if (policy) {
      paragraphs.push(
        `Your approved policy “${policy.name}” allows transfers of up to ${policy.maximumQuantity} units ` +
          `when the destination is at risk of running out and the source stays above its safety level.`
      );
    } else if (done && item.approvedAt) {
      paragraphs.push('You approved this one yourself.');
    } else if (!done && item.executionStatus !== workItems.STATUS.SUPERSEDED) {
      paragraphs.push('No policy covers this, so it is waiting for you rather than being carried out.');
    }

    paragraphs.push(
      done
        ? `I transferred ${action.quantity}.`
        : item.executionStatus === workItems.STATUS.SUPERSEDED
          ? `It would have moved ${action.quantity}. Nothing moved.`
          : `I want to move ${action.quantity}. Nothing has moved yet.`
    );

    if (outcome.after) {
      paragraphs.push(
        `Verified result: ${toName} ${outcome.after.destination}, ${fromName} ${outcome.after.source}. ` +
          `Total unchanged at ${outcome.after.total}.`
      );
    }
  } else if (item.category === 'replenishment_plan') {
    // One decision, so one explanation, and it has to carry both halves and the
    // arithmetic joining them — otherwise the page is back to presenting a move
    // and an order as two things that happen to share a product.
    const done = item.executionStatus === workItems.STATUS.COMPLETED;
    const moved = (action.transfers || []).reduce((total, move) => total + move.quantity, 0);

    paragraphs.push(
      item.executionStatus === workItems.STATUS.SUPERSEDED
        ? `Historical plan: ${action.explanation}`
        : done
          ? `When this plan was created: ${action.explanation}`
          : action.explanation
    );
    paragraphs.push(
      `${done || item.executionStatus === workItems.STATUS.SUPERSEDED ? 'At that time, ' : ''}` +
      (action.onOrder
        ? `On hand ${action.onHandTotal} plus ${action.onOrder} on order is ${action.networkPosition}`
        : `On hand ${action.onHandTotal}, with nothing on order`) +
        `, against a reorder point of ${action.reorderPoint} and an order-up-to level of ${action.target}. ` +
        (action.byLocation || []).map((loc) => `${loc.locationName} holds ${loc.onHand} and needs ${loc.need}`).join('; ') + '.'
    );

    if (action.prepared) {
      paragraphs.push(
        (done || item.executionStatus === workItems.STATUS.SUPERSEDED ? 'At that time, ' : '') +
          `${action.prepared.units} ${plan_unit(action)}(s) ` +
          `${done || item.executionStatus === workItems.STATUS.SUPERSEDED ? 'were' : 'are'} drafted on ` +
          `${action.prepared.orders.map((order) => order.poNumber).join(', ')}, which is why the plan ` +
          `${done || item.executionStatus === workItems.STATUS.SUPERSEDED ? 'proposed' : 'proposes'} no further order.` +
          (!done && item.executionStatus !== workItems.STATUS.SUPERSEDED
            ? ' Drafted is not the same as on order: nobody has told the supplier anything yet.'
            : '')
      );
    }

    if (moved && action.purchase) {
      paragraphs.push(
        (done
          ? `I moved ${moved} and prepared an order for `
          : item.executionStatus === workItems.STATUS.SUPERSEDED
            ? `The replaced plan would have moved ${moved} and ordered `
            : `I want to move ${moved} and order `) +
          `${action.purchase.quantityPurchaseUnits} ${action.purchase.purchaseUnit}(s) — ` +
          `${action.purchase.quantityUnits} units — from ${action.purchase.supplierName}. ` +
          'Moving stock does not change how much of it exists, so the order is the same size either way.'
      );
    } else if (moved) {
      paragraphs.push(
        done
          ? `I moved ${moved}.`
          : item.executionStatus === workItems.STATUS.SUPERSEDED
            ? `The replaced plan would have moved ${moved}. Nothing moved.`
            : `I want to move ${moved}. Nothing has moved yet.`
      );
    } else if (action.purchase) {
      paragraphs.push(
        (done
          ? 'I prepared an order for '
          : item.executionStatus === workItems.STATUS.SUPERSEDED
            ? 'The replaced plan would have ordered '
            : 'I want to order ') +
          `${action.purchase.quantityPurchaseUnits} ${action.purchase.purchaseUnit}(s) from ${action.purchase.supplierName}.`
      );
    }

    if (action.after) {
      // Say which figure this is. "56 in total" directly above a position of 80
      // reads as a contradiction unless it is clear one counts what is on the
      // shelf and the other counts what is on the shelf plus what is coming.
      paragraphs.push(
        'On hand afterwards: ' +
          action.after.byLocation.map((row) => `${row.locationName} ${row.before} → ${row.after}`).join(', ') +
          `, ${action.after.onHandAfterMoves} in total` +
          // Derived from the same breakdown the table below uses, not from the
          // projection stored when the plan was made — otherwise the sentence
          // and the table can disagree about the same product.
          (action.purchase || action.prepared
            ? `, rising to ${replenishmentPlan.positionBreakdown(planShape(action)).afterEveryOrderArrives} once the order arrives.`
            : '.')
      );
    }

    // What the button does is a list, not a sentence. It is rendered from the
    // plan by the same function the executor runs, so the promise and the
    // behaviour cannot describe different things.
    if (!done && item.executionStatus !== workItems.STATUS.SUPERSEDED) {
      paragraphs.push('Nothing has moved and nothing has been ordered yet.');
    }
  } else if (item.category === 'purchase_approval') {
    // This page had no branch at all for these, so "Why" showed the policy name
    // and nothing else — on the one screen where somebody is being asked to
    // accept a price rise.
    const po = action.poNumber || outcome.poNumber || 'the order';
    const exception = item.source === 'price_exception';
    const priceCheck = ((item.policyEvaluation || {}).checks || [])
      .find((entry) => /price/i.test(entry.name) && !entry.passed);

    if (item.executionStatus === workItems.STATUS.SUPERSEDED) {
      if (currentOrder) paragraphs.push(`Current order state: ${orderStateCopy(currentOrder)}`);
    } else if (item.executionStatus === workItems.STATUS.COMPLETED) {
      paragraphs.push(
        currentOrder
          ? `You approved this order. Current state: ${orderStateCopy(currentOrder)}`
          : 'You approved this order. Its purchase-order record is no longer available.'
      );
    } else {
      paragraphs.push(
        exception
          ? `${po} for ${action.supplierName || 'this supplier'} is ready, but it costs more than your rule allows.`
          : `${po} for ${action.supplierName || 'this supplier'} is prepared and waiting to be placed.`
      );
    }
    if (exception && !item.isTerminal) {
      paragraphs.push(
        (item.policyEvaluation || {}).reason ||
          `The price moved further than ${policy ? policy.name : 'your rule'} permits.`
      );
      if (priceCheck && priceCheck.detail) {
        paragraphs.push(`Measured against your limit: ${priceCheck.detail}.`);
      }
      paragraphs.push(
        'Everything else about the order passed. Approving accepts the new price and places this order; ' +
          'it does not change your rule, so the next order over the limit will stop here too.'
      );
    } else if (!item.isTerminal) {
      paragraphs.push('Approving places it with the supplier. Foundry does not contact anyone itself.');
    }
    // The link is rendered as a link. Telling somebody to go and open the order
    // without giving them a way to is the loop this whole pass is about.
    orderLink = item.purchaseOrderId || action.purchaseOrderId
      ? `/purchasing/orders/${item.purchaseOrderId || action.purchaseOrderId}`
      : null;
  } else if (item.category === 'purchase_preparation') {
    if (item.executionStatus === workItems.STATUS.SUPERSEDED) {
      if (currentOrder) paragraphs.push(`Current order state: ${orderStateCopy(currentOrder)}`);
    } else {
      paragraphs.push(
        `Replenishment showed ${plural((action.lines || []).length, 'line')} below their reorder point for ` +
          `${action.supplierName}, so I prepared ${outcome.poNumber || 'a draft order'}. ` +
          (currentOrder ? `Current state: ${orderStateCopy(currentOrder)}` : 'The order record is no longer available.')
      );
    }
  }

  const planForActions = item.category === 'replenishment_plan' ? planShape(action) : null;
  const planned = planForActions && !item.isTerminal ? replenishmentPlan.plannedActions(planForActions) : [];
  const positionBreakdown = planForActions ? replenishmentPlan.positionBreakdown(planForActions) : null;

  return {
    item,
    policy,
    supersededBy,
    orderLink,
    currentResult: item.executionStatus === workItems.STATUS.COMPLETED ? currentResult : null,
    // Only before it runs: afterwards the record of what happened is the truth,
    // and a list of intentions beside it would read as things still to come.
    actions: planned,
    position: positionBreakdown,
    approvalCopy: pendingReplenishmentCopy(item, action, planned, positionBreakdown),
    paragraphs,
    checks: (item.policyEvaluation || {}).checks || [],
    evidence: evidenceForDisplay(item),
    verification: verificationFor(item, currentResult),
    events: workItems.eventsFor(db, workspaceId, workItemId),
  };
}

/** "What did you do today?" as a spoken answer. */
function summariseDay(db, workspaceId, { now = Date.now() } = {}) {
  const did = whatFoundryDid(db, workspaceId, { now });
  const needs = whatNeedsYou(db, workspaceId);
  const lines = [];

  if (did.counts.handled === 0) {
    lines.push(
      did.counts.evaluations > 0
        ? `Nothing needed doing today. I checked ${plural(did.counts.positionsWatched, 'stock position')} against their movement history.`
        : 'Nothing today.'
    );
  } else {
    lines.push(`Today I handled ${plural(did.counts.handled, 'inventory task')}:`);
    for (const action of did.actions.slice(0, 8)) lines.push(`• ${action.headline}.`);
    if (did.counts.evaluations) {
      lines.push(`• Reviewed ${plural(did.counts.positionsWatched, 'stock position')}.`);
    }
    if (did.counts.findingsResolved) {
      lines.push(`• Closed ${plural(did.counts.findingsResolved, 'finding')} that resolved themselves.`);
    }
  }
  if (needs.length) lines.push(`I need you to look at ${plural(needs.length, 'thing')}.`);

  return { lines, did, needsYou: needs };
}

module.exports = {
  ordersOwnedByAPlan,
  currentOrderForWork,
  orderStateCopy,
  deliveryState,
  isCurrentlyActionable,
  timeAgo,
  recentEvaluations,
  describeCompleted,
  whatFoundryDid,
  whatFoundryPrepared,
  whatNeedsYou,
  whatsNext,
  operatorHome,
  notifications,
  explain,
  summariseDay,
};
