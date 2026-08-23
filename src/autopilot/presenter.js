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
const attention = require('../attention/attention-engine');
const managerReadiness = require('../manager/readiness');

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

/**
 * One line describing a piece of work, in a person's words.
 *
 * The history page groups work by what happened to it, so this is called for
 * items that are finished and items that never started. "Moved 15" against
 * something waiting for approval would be a plain untruth, so the verb follows
 * the status rather than the category.
 */
function describeCompleted(item) {
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
      detail: outcome.lines === undefined
        ? null
        : Number(outcome.subtotal) > 0
          ? `${plural(outcome.lines || 0, 'line')}, ${outcome.subtotal}. Waiting for you to approve it.`
          : `${plural(outcome.lines || 0, 'line')}, no prices on file yet. Waiting for you to approve it.`,
      verified: true,
      link: item.purchaseOrderId ? `/purchasing/orders/${item.purchaseOrderId}` : `/autopilot/work/${item.id}`,
    };
  }
  if (item.category === 'receiving_followup') {
    return {
      headline: done
        ? `Marked ${action.poNumber || 'a delivery'} as dealt with`
        : `${action.poNumber || 'A delivery'} from ${action.supplierName || 'a supplier'} needs booking in`,
      detail: action.late
        ? `${plural(action.daysLate || 0, 'day')} late, ${plural(action.outstandingUnits || 0, 'unit')} outstanding.`
        : `${plural(action.outstandingUnits || 0, 'unit')} outstanding. Foundry cannot book these in for you.`,
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

  const actions = completed.map(describeCompleted);
  const transfers = completed.filter((item) => item.category === 'balance_transfer');
  const purchases = completed.filter((item) => item.category === 'purchase_preparation');

  // Work Foundry has prepared and is holding. It carried nothing out, but
  // "nothing needed doing" would be false while it is standing there with
  // something that does.
  const prepared = workItems.awaitingApproval(db, workspaceId).length;

  return {
    since: from,
    actions,
    counts: {
      handled: completed.length,
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
      completed.length === 0
        ? prepared > 0
          ? `Checked ${plural(positionsWatched, 'stock position')} and prepared ` +
            `${plural(prepared, 'thing')} for you. Carried nothing out on its own.`
          : evaluations.length > 0 || sweeps.n > 0
            ? `Checked ${plural(positionsWatched, 'stock position')}. Nothing needed doing.`
            : 'Nothing yet today.'
        : `Handled ${plural(completed.length, 'task')}.`,
  };
}

/** Work Foundry has worked out already and is holding for review. */
function whatFoundryPrepared(db, workspaceId, { limit = 8 } = {}) {
  const waitingItems = workItems.awaitingApproval(db, workspaceId);
  const waitingOrderIds = new Set(waitingItems
    .map((item) => item.purchaseOrderId || (item.recommendedAction || {}).purchaseOrderId)
    .filter(Boolean));
  const waiting = waitingItems.map((item) => ({
    kind: 'work',
    id: item.id,
    title:
      item.category === 'balance_transfer'
        ? `Move ${item.recommendedAction.quantity} ${item.recommendedAction.displayName} to ${item.recommendedAction.toLocationName}?`
        : item.category === 'receiving_followup'
          ? `${item.recommendedAction.poNumber || 'A delivery'} from ${item.recommendedAction.supplierName} ` +
            `${item.recommendedAction.late ? 'is late' : 'is due'} — book it in`
          : item.category === 'purchase_approval' && item.source === 'price_exception'
            ? `${item.recommendedAction.poNumber || 'A purchase order'} has a price exception`
            : item.category === 'purchase_approval'
              ? `${item.recommendedAction.poNumber || 'A purchase order'} for ${item.recommendedAction.supplierName || 'the supplier'} is ready to send`
            : item.categoryLabel,
    because: (item.policyEvaluation || {}).reason || null,
    evidence: item.sourceEvidence || [],
    priority: item.priority,
    // A delivery reminder should land on the order, where one button books the
    // whole thing in — not on an explanation of why Foundry raised it.
    link:
      item.category === 'receiving_followup' && item.recommendedAction.purchaseOrderId
        ? `/purchasing/orders/${item.recommendedAction.purchaseOrderId}`
        : `/autopilot/work/${item.id}`,
    action: item.category === 'receiving_followup' ? 'Book it in' : 'Review',
  }));

  const drafts = db
    .prepare(
      `SELECT po.id, po.po_number, s.name AS supplier, po.status FROM purchase_orders po
         JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.workspace_id = ? AND po.status = 'DRAFT' ORDER BY po.created_at DESC LIMIT 5`
    )
    .all(workspaceId)
    .filter((row) => !waitingOrderIds.has(row.id))
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
        ? `${plural(planned, 'work item')} prepared; ${plural(awaiting, 'item')} waiting for a decision.`
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
      'replenishment_needed', 'low_stock', 'stockout_risk', 'unusual_adjustment',
      'data_integrity', 'supplier_price_change',
    ].includes(item.category))
    .filter((item) => !['low_stock', 'stockout_risk', 'replenishment_needed'].includes(item.category) || !workCoveredSkus.has(item.skuId))
    .map((item) => ({
      kind: 'finding',
      // The hydrated finding calls its own key attentionId. Reading `id` here
      // produced a Review button pointing at /attention/undefined.
      id: item.attentionId,
      title: item.narrativeTitle || item.title,
      because: item.conciseSummary,
      evidence: item.evidence || [],
      priority: item.priorityScore || 50,
      link: `/attention/${item.attentionId}`,
      action: 'Review',
    }))
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
      title: `${po.po_number} expected from ${po.supplier_name}`,
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

  const until = new Date(now + days * DAY_MS).toISOString().slice(0, 10);
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
    needsYou: [...operatingNeeds, ...investigationNeeds, ...physicalNeeds, ...prepared, ...whatNeedsYou(db, workspaceId)],
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

  const paragraphs = [];
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
    } else if (!done) {
      paragraphs.push('No policy covers this, so it is waiting for you rather than being carried out.');
    }

    paragraphs.push(
      done ? `I transferred ${action.quantity}.` : `I want to move ${action.quantity}. Nothing has moved yet.`
    );

    if (outcome.after) {
      paragraphs.push(
        `Verified result: ${toName} ${outcome.after.destination}, ${fromName} ${outcome.after.source}. ` +
          `Total unchanged at ${outcome.after.total}.`
      );
    }
  } else if (item.category === 'purchase_preparation') {
    paragraphs.push(
      `Replenishment showed ${plural((action.lines || []).length, 'line')} below their reorder point for ` +
        `${action.supplierName}, so I prepared ${outcome.poNumber || 'a draft order'} for you to review. ` +
        'Nothing has been sent to the supplier.'
    );
  }

  return {
    item,
    policy,
    paragraphs,
    checks: (item.policyEvaluation || {}).checks || [],
    evidence: item.sourceEvidence || [],
    verification: outcome.checks || [],
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
