'use strict';

/**
 * The loop, and the only place autonomous execution happens.
 *
 *   inventory truth → signals → planning → policy → approval decision
 *     → execution → verification → reevaluation → completion
 *
 * Three rules shape the code:
 *
 * Nothing here moves stock. Transfers go through the Mission 4 proposal and
 * execution services, which go through the Mission 1 engine — so an autonomous
 * transfer and a typed one are the same movement with the same invariants, and
 * the ledger cannot tell them apart except by who approved it.
 *
 * Policy is re-checked immediately before execution, not only at planning. The
 * world moves between the two: somebody else may have transferred the same
 * stock, and a plan that was authorised a minute ago may no longer be.
 *
 * A verification failure stops autonomy for that scope. Not a retry — a stop.
 * The dangerous failure of an automaton is not one wrong action, it is the same
 * wrong action repeated while nobody is watching.
 */

const { newId, nowIso } = require('../lib/util');
const { ValidationError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const repo = require('../domain/repository');
const proposals = require('../actions/proposal-service');
const execution = require('../actions/execution-service');
const poService = require('../purchasing/po-service');
const reevaluate = require('../attention/reevaluate');
const modes = require('./modes');
const policyService = require('./policy-service');
const policyEngine = require('./policy-engine');
const planner = require('./planner');
const signalEngine = require('../signals/signal-engine');
const workItems = require('./work-items');

function notify(db, workspaceId, { kind, severity = 'info', title, body = '', workItemId = null, link = null }) {
  db.prepare(
    `INSERT INTO notifications (id, workspace_id, kind, severity, title, body, work_item_id, link, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId('ntf'), workspaceId, kind, severity, title, body, workItemId, link, nowIso());
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * One round of the loop: work out what should happen, decide who may authorise
 * it, and record it. Nothing is executed here.
 */
function planWork(db, ctx, membership, options = {}) {
  const now = options.now || Date.now();
  const workspaceId = ctx.workspaceId;
  const state = modes.ensure(db, workspaceId);

  // A plan per trigger per minute: a scheduler firing twice, or two requests
  // racing, produce one plan rather than two.
  //
  // A person pressing "check now" is not that. Bucketing them by the minute
  // would mean the button did nothing for up to sixty seconds and said nothing
  // about why, which reads as Foundry ignoring them. Duplicate *work* is still
  // impossible — that is the work item's idempotency key, one layer down, and it
  // does not depend on when the question was asked.
  const key = options.idempotencyKey ||
    (options.trigger === 'manual'
      ? `plan:manual:${newId('req')}`
      : `plan:${options.trigger || 'scheduled'}:${new Date(now).toISOString().slice(0, 16)}`);
  const existing = db
    .prepare('SELECT * FROM work_plans WHERE workspace_id = ? AND idempotency_key = ?')
    .get(workspaceId, key);
  if (existing) {
    return { replayed: true, planId: existing.id, items: workItems.list(db, workspaceId, { limit: 50 }) };
  }

  const planId = newId('wplan');
  db.prepare(
    `INSERT INTO work_plans (id, workspace_id, trigger, idempotency_key, mode, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'PLANNING', ?)`
  ).run(planId, workspaceId, options.trigger || 'scheduled', key, state.mode, nowIso());

  const proposed = planner.plan(db, workspaceId, { now });
  const created = [];

  // --- transfers ------------------------------------------------------------
  for (const transfer of proposed.transfers) {
    const verdict = policyEngine.evaluate(db, workspaceId, {
      actionType: 'transfer',
      skuId: transfer.skuId,
      itemId: transfer.itemId,
      quantity: transfer.quantity,
      fromLocationId: transfer.fromLocationId,
      toLocationId: transfer.toLocationId,
      conditions: transfer.conditions,
    }, { now });

    const { item, created: isNew } = workItems.upsert(db, workspaceId, {
      workPlanId: planId,
      category: 'balance_transfer',
      source: 'balance_signal',
      sourceEvidence: transfer.evidence,
      affectedEntities: {
        skuId: transfer.skuId,
        itemId: transfer.itemId,
        displayName: transfer.displayName,
        fromLocationId: transfer.fromLocationId,
        toLocationId: transfer.toLocationId,
      },
      recommendedAction: {
        actionType: 'transfer',
        skuId: transfer.skuId,
        quantity: transfer.quantity,
        fromLocationId: transfer.fromLocationId,
        toLocationId: transfer.toLocationId,
        fromLocationName: transfer.fromLocationName,
        toLocationName: transfer.toLocationName,
        displayName: transfer.displayName,
      },
      priority: 100 - (transfer.conditions.destination_stockout_risk ? 0 : 10),
      urgency: 'soon',
      confidence: 'high',
      policyId: verdict.policy ? verdict.policy.id : null,
      policyEvaluation: { decision: verdict.decision, reason: verdict.reason, checks: verdict.checks },
      approvalRequirement: verdict.decision === 'authorized' ? 'NONE' : 'REQUIRED',
      executionStatus:
        verdict.decision === 'authorized' ? workItems.STATUS.AUTHORIZED : workItems.STATUS.WAITING_FOR_APPROVAL,
      idempotencyKey: workItems.keyFor('balance_transfer', {
        skuId: transfer.skuId,
        from: transfer.fromLocationId,
        to: transfer.toLocationId,
      }, { now }),
    });

    policyService.recordEvaluation(db, workspaceId, {
      policyId: verdict.policy ? verdict.policy.id : null,
      workItemId: item.id,
      decision: verdict.decision,
      reason: verdict.reason,
      checks: verdict.checks,
      policyVersion: verdict.policy ? verdict.policy.version : null,
    });

    // The same shortage already has a piece of work, but the rules have moved
    // since it was written down. While it is still only a suggestion, it is
    // brought in line rather than left in the way.
    let current = item;
    if (!isNew && item.needsPerson && !item.approvedAt && (item.recommendedAction || {}).quantity !== transfer.quantity) {
      current = workItems.resize(db, workspaceId, item.id, {
        recommendedAction: { ...item.recommendedAction, quantity: transfer.quantity },
        policyEvaluation: { decision: verdict.decision, reason: verdict.reason, checks: verdict.checks },
        approvalRequirement: verdict.decision === 'authorized' ? 'NONE' : 'REQUIRED',
        executionStatus:
          verdict.decision === 'authorized' ? workItems.STATUS.AUTHORIZED : workItems.STATUS.WAITING_FOR_APPROVAL,
        policyId: verdict.policy ? verdict.policy.id : null,
        reason: verdict.reason,
      });
    }

    if (isNew) {
      created.push(current);
      if (current.needsPerson) {
        notify(db, workspaceId, {
          kind: 'approval_required',
          severity: 'important',
          title: `Move ${transfer.quantity} ${transfer.displayName} to ${transfer.toLocationName}?`,
          body: verdict.reason,
          workItemId: item.id,
          link: `/autopilot/work/${item.id}`,
        });
      }
    }
  }

  // --- work that was only waiting on authority -------------------------------
  //
  // A transfer prepared while Foundry was supervised is waiting for a person
  // because nobody had given it authority yet — not because there was anything
  // wrong with it. Once the owner does, the same work qualifies on its own, and
  // leaving it sitting there would mean handing over authority changed nothing.
  //
  // Only the verdict decides. Work waiting because it is too big, because the
  // limit is spent, or because two policies disagree stays exactly where it is.
  for (const waiting of workItems.list(db, workspaceId, {
    status: workItems.STATUS.WAITING_FOR_APPROVAL,
    category: 'balance_transfer',
    limit: 200,
  })) {
    if (waiting.approvedAt) continue;
    const action = waiting.recommendedAction || {};
    if (!action.skuId || !action.quantity) continue;

    const [sku] = signalEngine.skuSignals(db, workspaceId, { skuIds: [action.skuId], now });
    if (!sku) continue;
    const replanned = planner.planBalanceTransfer(db, workspaceId, sku, {
      maximumQuantity: action.quantity,
      incoming: { onOrder: 0 },
    });

    const verdict = policyEngine.evaluate(db, workspaceId, {
      actionType: 'transfer',
      skuId: action.skuId,
      itemId: waiting.affectedEntities.itemId,
      quantity: action.quantity,
      fromLocationId: action.fromLocationId,
      toLocationId: action.toLocationId,
      conditions: replanned ? replanned.conditions : {},
    }, { now });
    if (verdict.decision !== 'authorized') continue;

    workItems.resize(db, workspaceId, waiting.id, {
      recommendedAction: action,
      policyEvaluation: { decision: verdict.decision, reason: verdict.reason, checks: verdict.checks },
      approvalRequirement: 'NONE',
      executionStatus: workItems.STATUS.AUTHORIZED,
      policyId: verdict.policy ? verdict.policy.id : null,
      reason: verdict.reason,
    });
  }

  // --- purchasing -----------------------------------------------------------
  for (const group of proposed.purchases) {
    const { item, created: isNew } = workItems.upsert(db, workspaceId, {
      workPlanId: planId,
      category: 'purchase_preparation',
      source: 'replenishment',
      sourceEvidence: group.lines.flatMap((line) => line.evidence || []).slice(0, 12),
      affectedEntities: { supplierId: group.supplierId, supplierName: group.supplierName },
      recommendedAction: {
        actionType: 'prepare_purchase_order',
        supplierId: group.supplierId,
        supplierName: group.supplierName,
        lines: group.lines,
        estimatedTotal: group.estimatedTotal,
      },
      priority: 60,
      urgency: 'normal',
      confidence: 'high',
      // Preparing a draft is not buying anything, so Foundry may do it — but
      // sending an order to a supplier is never automatic in Mission 7.
      approvalRequirement: 'NONE',
      executionStatus: workItems.STATUS.AUTHORIZED,
      idempotencyKey: workItems.keyFor('purchase_preparation', {
        supplierId: group.supplierId,
        lines: group.lines.map((line) => `${line.skuId}:${line.quantityPurchaseUnits}`).sort(),
      }, { now }),
    });
    if (isNew) created.push(item);
  }

  // --- deliveries -----------------------------------------------------------
  //
  // Always a person's job. Foundry raises it, links straight to receiving, and
  // never books anything in: what actually came in the box is a physical fact,
  // and Mission 7 does not guess at those.
  for (const delivery of proposed.receiving) {
    const { item, created: isNew } = workItems.upsert(db, workspaceId, {
      workPlanId: planId,
      category: 'receiving_followup',
      source: 'purchase_order',
      sourceEvidence: [
        { label: 'Expected', value: delivery.expectedDate },
        { label: 'Still outstanding', value: `${delivery.outstandingUnits} units` },
      ],
      affectedEntities: { purchaseOrderId: delivery.purchaseOrderId, supplierName: delivery.supplierName },
      recommendedAction: {
        actionType: 'receive_delivery',
        purchaseOrderId: delivery.purchaseOrderId,
        poNumber: delivery.poNumber,
        supplierName: delivery.supplierName,
        outstandingUnits: delivery.outstandingUnits,
        late: delivery.late,
        daysLate: delivery.daysLate,
      },
      priority: delivery.late ? 80 : 50,
      urgency: delivery.late ? 'soon' : 'normal',
      confidence: 'high',
      approvalRequirement: 'REQUIRED',
      executionStatus: workItems.STATUS.WAITING_FOR_APPROVAL,
      idempotencyKey: workItems.keyFor('receiving_followup', { purchaseOrderId: delivery.purchaseOrderId }, { now }),
    });
    if (isNew) {
      created.push(item);
      notify(db, workspaceId, {
        kind: 'approval_required',
        severity: delivery.late ? 'important' : 'info',
        title: delivery.late
          ? `${delivery.poNumber} from ${delivery.supplierName} is ${delivery.daysLate} days late`
          : `${delivery.poNumber} from ${delivery.supplierName} is due today`,
        body: `${delivery.outstandingUnits} units still outstanding. Foundry cannot book these in for you.`,
        workItemId: item.id,
        link: `/purchasing/orders/${delivery.purchaseOrderId}`,
      });
    }
  }

  // --- conflicts ------------------------------------------------------------
  for (const conflict of proposed.conflicts) {
    const { item, created: isNew } = workItems.upsert(db, workspaceId, {
      workPlanId: planId,
      category: 'discrepancy_review',
      source: 'policy_conflict',
      sourceEvidence: conflict.floors.map((floor) => ({
        label: floor.policy,
        value: `keeps ${floor.minimum} back`,
      })),
      affectedEntities: { skuId: conflict.skuId },
      recommendedAction: { actionType: 'review_policies', message: conflict.message },
      priority: 90,
      urgency: 'soon',
      confidence: 'high',
      approvalRequirement: 'REQUIRED',
      executionStatus: workItems.STATUS.WAITING_FOR_APPROVAL,
      idempotencyKey: workItems.keyFor('policy_conflict', { skuId: conflict.skuId }, { now }),
    });
    if (isNew) {
      created.push(item);
      notify(db, workspaceId, {
        kind: 'exception',
        severity: 'important',
        title: 'Your policies disagree about this product',
        body: conflict.message,
        workItemId: item.id,
      });
    }
  }

  const awaiting = workItems.awaitingApproval(db, workspaceId).length;
  db.prepare(
    `UPDATE work_plans SET status = 'PLANNED', items_planned = ?, items_awaiting = ?, summary = ?, finished_at = ?
      WHERE id = ?`
  ).run(
    created.length,
    awaiting,
    JSON.stringify({
      transfers: proposed.transfers.length,
      purchases: proposed.purchases.length,
      conflicts: proposed.conflicts.length,
      nothingToDo: proposed.nothingToDo,
    }),
    nowIso(),
    planId
  );
  modes.recordEvaluation(db, workspaceId);

  return { replayed: false, planId, created, nothingToDo: proposed.nothingToDo, conflicts: proposed.conflicts };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Carries out one authorised piece of work.
 *
 * Policy is re-evaluated first against current inventory, because between
 * planning and now somebody may have moved the same stock — and a plan that was
 * authorised then may not be authorised now.
 */
function executeWorkItem(db, ctx, membership, workItemId, options = {}) {
  const workspaceId = ctx.workspaceId;
  const item = workItems.get(db, workspaceId, workItemId);

  if (item.isTerminal) return { replayed: true, item };
  if (item.executionStatus === workItems.STATUS.WAITING_FOR_APPROVAL) {
    throw new ValidationError('That work is waiting for a person to approve it.');
  }

  if (item.category === 'purchase_preparation') return preparePurchase(db, ctx, membership, item);

  // A delivery is checked in by a person against what is physically in the box.
  // Marking the reminder done is all that happens here; the stock itself arrives
  // through Mission 6 receiving, which is where the counting is.
  if (item.category === 'receiving_followup') {
    workItems.transition(db, workspaceId, item.id, workItems.STATUS.COMPLETED, {
      completedAt: nowIso(),
      outcome: { acknowledged: true, purchaseOrderId: (item.recommendedAction || {}).purchaseOrderId },
      verificationStatus: 'NOT_APPLICABLE',
    });
    return { executed: false, acknowledged: true, item: workItems.get(db, workspaceId, item.id) };
  }

  if (item.category !== 'balance_transfer') {
    throw new ValidationError('Foundry does not carry out that kind of work on its own.');
  }

  const action = item.recommendedAction;

  // --- revalidate -----------------------------------------------------------
  const fresh = planner;
  const [sku] = signalEngine.skuSignals(db, workspaceId, { skuIds: [action.skuId] });
  const sourceBalance = repo.getBalance(db, workspaceId, action.skuId, action.fromLocationId);

  if (!sku || sourceBalance < action.quantity) {
    workItems.transition(db, workspaceId, item.id, workItems.STATUS.CANCELLED, {
      errorMessage: `Only ${sourceBalance} left at the source when it came to it — someone else moved this stock.`,
      detail: { revalidation: 'insufficient_source' },
    });
    return { executed: false, item: workItems.get(db, workspaceId, item.id), because: 'the stock moved first' };
  }

  // Re-plan from current numbers and re-check the policy against those.
  const replanned = fresh.planBalanceTransfer(db, workspaceId, sku, {
    maximumQuantity: action.quantity,
    incoming: { onOrder: 0 },
  });
  const conditions = replanned ? replanned.conditions : {};

  const verdict = policyEngine.evaluate(db, workspaceId, {
    actionType: 'transfer',
    skuId: action.skuId,
    itemId: item.affectedEntities.itemId,
    quantity: action.quantity,
    fromLocationId: action.fromLocationId,
    toLocationId: action.toLocationId,
    conditions,
  }, { now: options.now || Date.now() });

  const preApproved = item.approvalRequirement === 'REQUIRED' && item.approvedAt;
  if (verdict.decision !== 'authorized' && !preApproved) {
    policyService.recordEvaluation(db, workspaceId, {
      policyId: verdict.policy ? verdict.policy.id : null,
      workItemId: item.id,
      decision: verdict.decision,
      reason: verdict.reason,
      checks: verdict.checks,
    });
    workItems.transition(db, workspaceId, item.id, workItems.STATUS.CANCELLED, {
      errorMessage: verdict.reason,
      detail: { revalidation: verdict.decision },
    });
    return { executed: false, item: workItems.get(db, workspaceId, item.id), because: verdict.reason };
  }

  // --- execute --------------------------------------------------------------
  workItems.transition(db, workspaceId, item.id, workItems.STATUS.EXECUTING, { countAttempt: true });

  const before = {
    source: sourceBalance,
    destination: repo.getBalance(db, workspaceId, action.skuId, action.toLocationId),
  };
  before.total = before.source + before.destination;

  let done;
  try {
    const built = proposals.build(db, ctx, {
      actionType: 'transfer',
      resolvedSkuId: action.skuId,
      quantity: action.quantity,
      sourceLocation: action.fromLocationName,
      destinationLocation: action.toLocationName,
      assumptions: [],
    });
    if (!built.ok) throw new ValidationError(built.question || built.unsupported || 'Could not build the transfer.');

    const stored = proposals.persist(db, ctx, built.proposal, {
      instruction: `Autopilot: ${item.idempotencyKey}`,
      source: 'FOUNDRY_RECOMMENDATION',
    });
    execution.approve(db, ctx, membership, stored.proposalId);
    done = execution.execute(db, ctx, membership, stored.proposalId, {
      idempotencyKey: `autopilot:${item.id}`,
    });

    workItems.transition(db, workspaceId, item.id, workItems.STATUS.VERIFYING, {
      proposalId: stored.proposalId,
      movementIds: done.movementIds || [],
    });
  } catch (error) {
    workItems.transition(db, workspaceId, item.id, workItems.STATUS.FAILED, {
      errorMessage: error.message,
      verificationStatus: 'NOT_APPLICABLE',
    });
    notify(db, workspaceId, {
      kind: 'action_failed',
      severity: 'important',
      title: `Could not move ${action.displayName}`,
      body: error.message,
      workItemId: item.id,
    });
    return { executed: false, item: workItems.get(db, workspaceId, item.id), error: error.message };
  }

  // --- verify ---------------------------------------------------------------
  const after = {
    source: repo.getBalance(db, workspaceId, action.skuId, action.fromLocationId),
    destination: repo.getBalance(db, workspaceId, action.skuId, action.toLocationId),
  };
  after.total = after.source + after.destination;

  const checks = [
    { name: 'Source went down by the amount moved', ok: after.source === before.source - action.quantity },
    { name: 'Destination went up by the amount moved', ok: after.destination === before.destination + action.quantity },
    { name: 'Total across both locations is unchanged', ok: after.total === before.total },
  ];
  const verified = checks.every((entry) => entry.ok);

  if (!verified) {
    workItems.transition(db, workspaceId, item.id, workItems.STATUS.FAILED, {
      verificationStatus: 'FAILED',
      outcome: { before, after, checks },
      errorMessage: 'The result of this transfer could not be verified.',
    });
    // Stop, rather than try again. Something is wrong that another attempt
    // would only repeat.
    modes.suspend(db, workspaceId, {
      scope: 'transfer',
      reason: `Foundry paused automatic transfers because the last one could not be independently verified (${action.displayName}).`,
    });
    return { executed: true, verified: false, item: workItems.get(db, workspaceId, item.id), checks };
  }

  const completed = workItems.transition(db, workspaceId, item.id, workItems.STATUS.COMPLETED, {
    verificationStatus: 'VERIFIED',
    outcome: { before, after, checks, quantity: action.quantity },
  });

  notify(db, workspaceId, {
    kind: 'action_completed',
    severity: 'info',
    title: `Moved ${action.quantity} ${action.displayName} to ${action.toLocationName}`,
    body: `${action.fromLocationName} ${before.source} → ${after.source}, ${action.toLocationName} ${before.destination} → ${after.destination}.`,
    workItemId: item.id,
    link: `/autopilot/work/${item.id}`,
  });

  try {
    reevaluate.refresh(db, workspaceId, 'autopilot');
  } catch {
    /* a failed sweep must not undo work that succeeded */
  }

  return { executed: true, verified: true, item: completed, before, after, checks };
}

/**
 * Prepares a draft purchase order. Never sends one.
 */
function preparePurchase(db, ctx, membership, item) {
  const action = item.recommendedAction;
  workItems.transition(db, ctx.workspaceId, item.id, workItems.STATUS.EXECUTING, { countAttempt: true });

  try {
    const order = poService.createOrder(db, ctx, membership, {
      supplierId: action.supplierId,
      source: 'foundry_recommendation',
      sourceDetail: { workItemId: item.id },
      lines: action.lines.map((line) => ({
        skuId: line.skuId,
        quantityPurchaseUnits: line.quantityPurchaseUnits,
      })),
    });

    const completed = workItems.transition(db, ctx.workspaceId, item.id, workItems.STATUS.COMPLETED, {
      purchaseOrderId: order.id,
      verificationStatus: 'NOT_APPLICABLE',
      outcome: { poNumber: order.poNumber, subtotal: order.subtotal, lines: order.lines.length },
    });

    notify(db, ctx.workspaceId, {
      kind: 'purchase_prepared',
      severity: 'important',
      title: `Prepared ${order.poNumber} for ${action.supplierName}`,
      body: `${order.lines.length} line(s), ${order.subtotal}. Nothing has been sent — review and approve it.`,
      workItemId: item.id,
      link: `/purchasing/orders/${order.id}`,
    });
    return { executed: true, item: completed, purchaseOrderId: order.id };
  } catch (error) {
    workItems.transition(db, ctx.workspaceId, item.id, workItems.STATUS.FAILED, {
      errorMessage: error.message,
      verificationStatus: 'NOT_APPLICABLE',
    });
    return { executed: false, item: workItems.get(db, ctx.workspaceId, item.id), error: error.message };
  }
}

/** A person approving work Foundry prepared. */
function approveWorkItem(db, ctx, membership, workItemId) {
  permissions.assertCan(membership, permissions.OPERATE, 'approve inventory work');
  const item = workItems.get(db, ctx.workspaceId, workItemId);
  if (item.executionStatus !== workItems.STATUS.WAITING_FOR_APPROVAL) {
    throw new ValidationError('That work is not waiting for approval.');
  }
  return workItems.transition(db, ctx.workspaceId, workItemId, workItems.STATUS.AUTHORIZED, {
    approvedByUserId: ctx.actorId,
    approvedAt: nowIso(),
  });
}

function cancelWorkItem(db, ctx, membership, workItemId, reason) {
  permissions.assertCan(membership, permissions.OPERATE, 'cancel inventory work');
  return workItems.transition(db, ctx.workspaceId, workItemId, workItems.STATUS.CANCELLED, {
    errorMessage: reason || 'Cancelled.',
  });
}

// ---------------------------------------------------------------------------
// The loop, and getting back on your feet after a restart
// ---------------------------------------------------------------------------

/**
 * Work left mid-flight by a crash, reconciled against the ledger.
 *
 * Never retried blindly: whether the transfer happened is a question the
 * movements answer, and the execution record carries an idempotency key that
 * makes the answer findable.
 */
function recover(db, ctx, membership) {
  const workspaceId = ctx.workspaceId;
  const recovered = [];

  for (const item of workItems.inFlight(db, workspaceId)) {
    const attempt = execution.findExecution(db, workspaceId, `autopilot:${item.id}`);

    if (attempt && attempt.status === 'SUCCEEDED') {
      // It did happen. Finish the bookkeeping rather than repeat the movement.
      recovered.push(
        workItems.transition(db, workspaceId, item.id, workItems.STATUS.COMPLETED, {
          verificationStatus: 'VERIFIED',
          outcome: { recovered: true, note: 'Completed on a previous run; reconciled after a restart.' },
        })
      );
      continue;
    }
    if (attempt && attempt.status === 'FAILED') {
      recovered.push(
        workItems.transition(db, workspaceId, item.id, workItems.STATUS.FAILED, {
          errorMessage: attempt.error_message || 'The attempt failed before the restart.',
          verificationStatus: 'NOT_APPLICABLE',
        })
      );
      continue;
    }

    // No execution was ever claimed, so nothing moved. Safe to plan again.
    recovered.push(
      workItems.transition(db, workspaceId, item.id, workItems.STATUS.BLOCKED, {
        errorMessage: 'Interrupted before anything moved. Left for review rather than retried automatically.',
      })
    );
  }
  return recovered;
}

/**
 * One full turn: recover, plan, then execute what is authorised.
 */
function run(db, ctx, membership, options = {}) {
  const workspaceId = ctx.workspaceId;
  const recovered = recover(db, ctx, membership);
  const planned = planWork(db, ctx, membership, options);

  const executed = [];
  const state = modes.get(db, workspaceId);
  if (state.canAct) {
    for (const item of workItems.list(db, workspaceId, { status: workItems.STATUS.AUTHORIZED, limit: 25 })) {
      try {
        executed.push(executeWorkItem(db, ctx, membership, item.id, options));
      } catch (error) {
        executed.push({ executed: false, error: error.message, workItemId: item.id });
      }
    }
  }

  return {
    recovered: recovered.length,
    planId: planned.planId,
    replayed: planned.replayed === true,
    planned: (planned.created || []).length,
    executed: executed.filter((entry) => entry.executed).length,
    awaiting: workItems.awaitingApproval(db, workspaceId).length,
    nothingToDo: planned.nothingToDo === true && executed.length === 0,
    results: executed,
  };
}

module.exports = {
  planWork,
  executeWorkItem,
  preparePurchase,
  approveWorkItem,
  cancelWorkItem,
  recover,
  run,
  notify,
};
